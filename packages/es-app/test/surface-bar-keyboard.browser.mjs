// The Surface reader bar by keyboard (DD's top-bar condition: every control stays reachable in order). Tab walks the
// bar in visual order: author chip, ⋯, close; the title (heading) and "✓ Seen" (a status since the item 8 pass) are
// not stops. ⋯ opens with Enter and its items follow in order (Find, Open in new tab, Copy reference, Mark unread);
// Escape closes it and returns focus to ⋯. Shift+Tab walks back. Fixture Surface and store.
// Run from packages/es-app: node test/surface-bar-keyboard.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const SURFACE = { id: "review", title: "Design review", summary: null, kind: "path", owner: "opencode/ux-feel", lane: "ux-feel", editspace: "fixture", purpose: "deliverable", updated_at: now, revision: 2, seen: true, seen_at: now - 60_000, health: { state: "ok" } }
const PAGE = "<!doctype html><html><body><h1>Design review</h1><p>Body.</p></body></html>"
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(30_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } }))
await page.route("**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } }))
await page.route("**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts" }, body: PAGE }))
await page.route("**/es/api/frontdesk/deliverables/seen", (route) => route.fulfill({ json: { ok: true } }))
await page.route((url) => new URL(url).pathname === "/es/api/surfaces/review/comments", (route) => route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "review", comments: [] } }))
// The focused control's name as assistive tech gets it: its label, else its text without aria-hidden parts.
const name = () => page.evaluate(() => {
  const el = document.activeElement
  if (!el) return ""
  if (el.getAttribute("aria-label")) return el.getAttribute("aria-label")
  const copy = el.cloneNode(true)
  copy.querySelectorAll("[aria-hidden=true]").forEach((node) => node.remove())
  return copy.textContent.trim().slice(0, 40)
})
const inBar = () => page.evaluate(() => !!document.activeElement?.closest(".surface-head"))
try {
  await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const bar = page.locator(".surface-head")
  await expect(bar.locator(".surface-done")).toHaveText("✓ Seen", { timeout: 60_000 })
  // The page is loaded and the bar settled before walking it (a late remount would move focus).
  await expect(page.frameLocator(".desk-surface-frame").locator("h1")).toHaveText("Design review")
  // Seen is a status, not a stop; the title is a heading.
  await expect(bar.locator(".surface-done")).toHaveAttribute("role", "status")
  expect(await bar.locator(".surface-done").evaluate((el) => el.tabIndex)).toBe(-1)
  await expect(bar.locator("h2")).toHaveText("Design review")
  // The chip's avatar letter is decoration: its name is the author's, once.
  // Forward: chip, ⋯, close, then out of the bar.
  await bar.locator(".surface-owner-chip").focus()
  const forward = [await name()]
  for (let i = 0; i < 2; i++) { await page.keyboard.press("Tab"); forward.push(await name()) }
  expect(forward[0]).toBe("Ux feel")
  expect(forward.slice(1)).toEqual(["More", "Close and return to chat"])
  await page.keyboard.press("Tab")
  expect(await inBar()).toBe(false)
  // Back: close, ⋯, chip.
  await page.keyboard.press("Shift+Tab")
  const back = [await name()]
  for (let i = 0; i < 2; i++) { await page.keyboard.press("Shift+Tab"); back.push(await name()) }
  expect(back).toEqual(["Close and return to chat", "More", "Ux feel"])
  // ⋯ opens by keyboard; its items follow in order; Escape closes it and returns to ⋯.
  await page.keyboard.press("Tab")
  expect(await name()).toBe("More")
  await page.keyboard.press("Enter")
  await expect(bar.locator(".surface-more")).toHaveAttribute("open", "")
  const items = []
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); items.push(await name()) }
  expect(items).toEqual(["Find in page", "Open in new tab", "Copy reference", "Mark unread"])
  await page.keyboard.press("Escape")
  await expect(bar.locator(".surface-more")).not.toHaveAttribute("open", "")
  expect(await name()).toBe("More")
  // The chip's menu opens by keyboard too and closes back to the chip.
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Enter")
  await expect(bar.locator(".surface-owner-menu")).toHaveAttribute("open", "")
  await page.keyboard.press("Escape")
  expect(await name()).toBe("Ux feel")
  expect(errors).toEqual([])
  console.log("surface-bar-keyboard: PASS")
} finally {
  await browser.close()
  await preview.close()
}

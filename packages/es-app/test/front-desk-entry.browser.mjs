// The Front desk entry (DD, Desk2963): (1) its busy dot stays visible and unobscured while the row is hovered or
// focused, LTR, RTL and 390; the row stays clickable and keyboard-reachable. (2) The top-bar Front desk toggle (Mac
// app header, enabled here by the Electron user agent) shares the sidebar entry's state both ways, by mouse and
// keyboard, keeps the composer draft and the current route, and opens one companion only.
// Run from packages/es-app: node test/front-desk-entry.browser.mjs
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.status = "busy"
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) es-desktop/1.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36"
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
let failed = false
const open = async (viewport, extra = {}) => {
  const context = await browser.newContext({ viewport, ...extra })
  await context.addInitScript(value => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  return { context, page }
}
// The element actually drawn at the dot's centre must be the dot itself.
const dotOnTop = page => page.evaluate(() => {
  const dot = document.querySelector("[data-nav=front-desk] .nav-busy")
  if (!dot) return "no dot"
  const box = dot.getBoundingClientRect()
  if (!box.width) return "dot has no size"
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return top === dot ? "ok" : `covered by ${top?.tagName}.${top?.className}`
})
try {
  for (const [name, viewport, rtl] of [["1440", { width: 1440, height: 900 }, false], ["rtl", { width: 1440, height: 900 }, true], ["390", { width: 390, height: 844 }, false]]) {
    const { context, page } = await open(viewport)
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
    const row = page.locator("[data-nav=front-desk]")
    await expect(row.locator(".nav-busy")).toBeVisible({ timeout: 120_000 })
    await row.hover()
    assert.equal(await dotOnTop(page), "ok", `${name}: busy dot while hovered`)
    await row.focus()
    assert.equal(await dotOnTop(page), "ok", `${name}: busy dot while focused`)
    await page.keyboard.press("Enter")
    await expect(row).toHaveAttribute("aria-pressed", "true")
    console.log(`DOT ${name}: visible and on top while hovered and focused; Enter toggles`)
    await context.close()
  }

  const { context, page } = await open({ width: 1440, height: 900 }, { userAgent })
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const header = page.locator(".native-header .header-desk-toggle")
  const entry = page.locator("[data-nav=front-desk]")
  await expect(header).toBeVisible({ timeout: 120_000 })
  await expect(header).toHaveAttribute("aria-label", "Porter (Front desk)")
  const editor = page.locator(".session-page:not(.desk-companion *) textarea").first()
  await editor.fill("draft kept across the toggle")
  const route = page.url()
  // Top bar opens; the sidebar entry agrees; one companion.
  await header.click()
  await expect(header).toHaveAttribute("aria-pressed", "true")
  await expect(entry).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(".desk-companion:not(.closed)")).toHaveCount(1)
  // The sidebar entry closes; the top bar agrees.
  await entry.click()
  await expect(header).toHaveAttribute("aria-pressed", "false")
  await expect(page.locator(".desk-companion:not(.closed)")).toHaveCount(0)
  // Keyboard on the top-bar control.
  await header.focus()
  await page.keyboard.press("Enter")
  await expect(entry).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Space")
  await expect(entry).toHaveAttribute("aria-pressed", "false")
  await expect(header).toBeFocused()
  await expect(editor).toHaveValue("draft kept across the toggle")
  assert.equal(page.url(), route, "the route did not change")
  // A button in the drag region does not drag the window.
  assert.equal(await header.evaluate(element => getComputedStyle(element).webkitAppRegion ?? getComputedStyle(element).getPropertyValue("-webkit-app-region")), "no-drag")
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(header).toBeVisible()
  console.log("TOGGLE: top bar and sidebar share one state both ways, mouse and keyboard; draft and route kept; no-drag; RTL visible")
  await context.close()
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("PASS front-desk-entry")

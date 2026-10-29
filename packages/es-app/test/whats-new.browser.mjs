// What's new (META-08): unseen notes open once after startup, only in the visible and focused view, and showing them
// marks the release seen for every view (a background view never shows them and stays usable); a seen release
// does not reopen by itself but the "What's new" entry shows it (without marking again); typing in an editor holds
// the dialog back until input pauses, then focus returns to the editor; no notes (404) never pops up and the entry
// says so. Also 390px RTL. Disposable fixture. Run from packages/es-app: node test/whats-new.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
// Each page reports focus from window.__focused (headless pages all claim focus otherwise); default focused.
await context.addInitScript(() => { Document.prototype.hasFocus = function () { return window.__focused !== false } })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const release = "1.4.0+abc1234"
const notes = { schema: "release-notes/1", release, items: [
  { title: "Pinned reorders by drag", detail: "Or Alt+Up/Down on a pinned row.", try: { label: "Open Agents", href: "/agents" } },
  { title: "Mini decisions open in Work", try: { label: "Read more", href: "https://example.test/notes" } },
], limits: ["Created sort waits for Core"] }
let served = { status: 200, body: { release, notes, seen: false } }
const marks = []
await context.route("**/__es/release-notes", (route) => served.status === 200 ? route.fulfill({ json: served.body }) : route.fulfill({ status: served.status, body: "" }))
await context.route("**/__es/release-notes/seen", (route) => { marks.push(route.request().postDataJSON()); served.body = { ...served.body, seen: true }; return route.fulfill({ status: 204, body: "" }) })
const dialog = page.getByRole("dialog", { name: "What's new" })
const entry = page.locator("nav.sidebar").getByRole("button", { name: "What's new" })
try {
  // Two views over one seen store; the second is in the background (not focused) and never shows it.
  const background = await context.newPage()
  await background.addInitScript(() => { window.__focused = false })
  await background.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  // Unseen: opens once after startup in the focused view, which marks the release seen at once.
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(dialog).toBeVisible({ timeout: 120_000 })
  await expect.poll(() => marks).toEqual([{ release }])
  // The background view: no dialog, its composer stays usable; brought to the front later, it still shows nothing.
  await expect(background.getByRole("textbox", { name: "Message", exact: true })).toBeEditable({ timeout: 120_000 })
  await background.evaluate(() => { window.__focused = true; window.dispatchEvent(new Event("focus")) })
  await background.waitForTimeout(2500)
  await expect(background.getByRole("dialog", { name: "What's new" })).toBeHidden()
  await background.getByRole("textbox", { name: "Message", exact: true }).fill("still typing here")
  await background.close()
  await expect(dialog.getByText("Pinned reorders by drag")).toBeVisible()
  await expect(dialog.getByRole("link", { name: "Open Agents" })).toHaveAttribute("href", "/agents")
  await expect(dialog.getByRole("link", { name: "Read more" })).toHaveAttribute("target", "_blank")
  await expect(dialog.getByText("Created sort waits for Core")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Got it" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  expect(marks).toEqual([{ release }])

  // Seen: no popup after reload; the entry reopens it and closing does not mark again.
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(entry).toBeVisible({ timeout: 120_000 })
  await page.waitForTimeout(2500)
  await expect(dialog).toBeHidden()
  await entry.click()
  await expect(dialog.getByText("Mini decisions open in Work")).toBeVisible()
  await dialog.getByRole("button", { name: "Got it" }).click()
  await expect(dialog).toBeHidden()
  await expect(entry).toBeFocused()
  expect(marks).toHaveLength(1)

  // A new release while typing: held back while input continues, shown after a pause, focus back in the editor.
  served = { status: 200, body: { release: "1.4.1+def5678", notes: { ...notes, release: "1.4.1+def5678" }, seen: false } }
  await page.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded" })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await editor.click({ timeout: 120_000 })
  for (let i = 0; i < 8; i++) { await page.keyboard.type("draft "); await page.waitForTimeout(400) }
  await expect(dialog).toBeHidden()
  await expect(dialog).toBeVisible({ timeout: 8000 })
  await page.keyboard.press("Escape")
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(/draft draft/)
  expect(marks.at(-1)).toEqual({ release: "1.4.1+def5678" })

  // No notes for this build (404): never pops up; the entry says so.
  served = { status: 404 }
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded" })
  await expect(entry).toBeVisible({ timeout: 120_000 })
  await page.waitForTimeout(2500)
  await expect(dialog).toBeHidden()
  await entry.click()
  await expect(dialog.getByText("No notes for this release.")).toBeVisible()

  // RTL, narrow.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const box = await dialog.boundingBox()
  if (!box || box.x < 0 || box.x + box.width > 390) throw new Error(`dialog clipped at 390px RTL: ${JSON.stringify(box)}`)
  await page.screenshot({ path: "/tmp/whats-new-rtl-390.png" })
  expect(errors).toEqual([])
  console.log("whats-new: PASS")
} finally {
  await browser.close()
  await preview.close()
}

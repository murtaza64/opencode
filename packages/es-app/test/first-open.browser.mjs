// First open of a session with independently held Core reads (readiness contract L3, startup owner).
// History (messages) held: the editor takes typing at once and Send is enabled as soon as the session
// record is known; the transcript shows a loading state, not an empty conversation. Releasing history
// fills the transcript. One send, no duplicate.
// Run from packages/es-app: node test/first-open.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
// Independently held reads: history (message pages) and the per-directory status list.
const hold = { history: true, status: true }
const held = { history: [], status: [] }
await page.route(/\/oc\//, (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\/oc/, "")
  if (route.request().method() !== "GET") return route.continue()
  if (hold.history && /^\/session\/ses_a\/message$/.test(path)) return void held.history.push(route)
  if (hold.status && path === "/session/status") return void held.status.push(route)
  return route.continue()
})
const editor = page.getByRole("textbox", { name: "Message", exact: true })
const send = page.locator(".prompt-box .direct-primary").first()
const sends = () => fixture.calls.filter((call) => call.method === "POST" && /\/(input|prompt_async)$/.test(call.path))
try {
  const started = Date.now()
  await page.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 300_000 })
  await expect.poll(() => held.history.length, { timeout: 60_000 }).toBeGreaterThan(0)
  // Typing never waits.
  await editor.fill("typed before history")
  await expect(editor).toHaveValue("typed before history")
  // Send waits only for the session record, not history or status.
  await expect(send).toBeEnabled({ timeout: 5_000 })
  const sendReadyMs = Date.now() - started
  // The transcript says it is reading, rather than showing an empty conversation.
  await expect(page.locator('[aria-busy="true"]').first()).toBeAttached()
  console.info(`PASS history and status held: typing works, Send enabled (${sendReadyMs} ms after navigation), transcript busy`)

  await send.click()
  await expect.poll(() => sends().length).toBe(1)
  await expect(page.locator(".outgoing, .pending-msg").first()).toContainText("typed before history")
  console.info("PASS send before history: one request, bubble shown")

  hold.history = false
  hold.status = false
  held.history.splice(0).forEach((route) => route.continue().catch(() => {}))
  held.status.splice(0).forEach((route) => route.continue().catch(() => {}))
  await expect(page.locator('[data-component="user-message"]').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.session-main [aria-busy="true"]')).toHaveCount(0)
  expect(sends()).toHaveLength(1)
  console.info("PASS history released: transcript filled, not busy, still one send")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

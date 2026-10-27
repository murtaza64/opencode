// es-app incident: with a draft present on a busy session, Steer stays available while the daemon
// is slow. (1) A reconnect snapshot that hangs must not disable Steer or turn activity "unknown".
// (2) A capabilities read that fails recovers by itself. No duplicate send.
// Run from packages/es-app: node test/input-availability.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "busy"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
let holdSnapshot = false, failCapabilities = false, failInputs = false
const held = []
await page.route(/\/oc\//, (route) => {
  const url = new URL(route.request().url())
  if (failCapabilities && url.pathname.endsWith("/experimental/capabilities")) return route.fulfill({ status: 503, body: "{}" })
  if (failInputs && route.request().method() === "GET" && /\/input(\/|$)/.test(url.pathname)) return route.abort("connectionrefused")
  if (holdSnapshot && route.request().method() === "GET" && /\/session\/ses_a(\/message)?$/.test(url.pathname.replace(/^\/oc/, ""))) return void held.push(route)
  return route.continue()
})
const editor = page.getByRole("textbox", { name: "Message", exact: true })
// The primary send button (Queue or Steer while busy, Send while idle).
const steer = page.locator(".prompt-box .direct-primary").first()
const status = page.locator(".session-work-status").first()
try {
  await page.goto(preview.url, { timeout: 300_000 })
  await expect(status).toHaveAttribute("data-state", "working")
  await editor.fill("draft while the daemon is slow")
  await expect(steer).toBeEnabled()

  // 1. The event stream drops and the reconnect snapshot never answers.
  holdSnapshot = true
  fixture.disconnect()
  await page.waitForTimeout(6000)
  await expect(steer).toBeEnabled()
  await expect(status).not.toHaveAttribute("data-state", /unknown/)
  console.info(`PASS hung reconnect snapshot: Steer enabled, status ${await status.getAttribute("data-state")}`)
  holdSnapshot = false
  held.splice(0).forEach((route) => route.continue().catch(() => {}))

  // 1b. Stream still down, status unknown: the primary action is Steer (busy), and sending it
  // admits exactly one durable /input steer (never prompt_async); the bubble shows at once.
  await expect(steer).toHaveText(/Steer|Queue/)
  await page.locator(".prompt-box textarea").first().focus()
  const posted = () => fixture.calls.filter((call) => call.method === "POST" && /\/(input|prompt_async)$/.test(call.path))
  const before1 = posted().length
  await page.keyboard.press("Meta+Enter")
  await expect.poll(() => posted().length).toBe(before1 + 1)
  expect(posted().at(-1).path).toMatch(/\/input$/)
  expect(posted().at(-1).body.requestID).toBeTruthy()
  await expect(page.locator(".outgoing, .pending-msg, .composer-results").first()).toContainText("draft while the daemon is slow")
  console.info(`PASS stream down: one durable /input ${posted().at(-1).body.delivery}, bubble shown`)
  // 2. Capabilities fail on reload, then recover without user action.
  failCapabilities = true
  await page.reload({ timeout: 300_000 })
  await editor.fill("draft after reload")
  await page.waitForTimeout(3000)
  failCapabilities = false
  await expect(steer).toBeEnabled({ timeout: 15_000 })
  console.info("PASS failed capabilities recover by themselves; Steer enabled")

  // 3. Receipt reads fail ("Failed to fetch"): no composer error, Steer stays enabled.
  failInputs = true
  await page.waitForTimeout(12_000)
  await expect(page.locator(".direct-composer")).not.toContainText(/Cannot refresh inputs|Failed to fetch/)
  await expect(steer).toBeEnabled()
  failInputs = false
  console.info("PASS failing receipt reads stay quiet; Steer enabled")
  const before = posted().length
  await editor.fill("draft after reload")
  await steer.click()
  await expect.poll(() => posted().length).toBe(before + 1)
  await page.waitForTimeout(1500)
  expect(posted().length).toBe(before + 1)
  console.info("PASS one Steer, one input")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

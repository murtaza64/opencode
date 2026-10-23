// App-wide quiet backend status (es-app#190, #186). Front desk under 502 bursts, offline and a
// refused (403) ignored-failures read: no warning cards accumulate, no raw URLs/JSON, queue and
// header geometry hold, the Needs-you count never drops to a falsely healthy value, and one
// header indicator carries the detail behind a disclosure. Then a held session send: the
// composer controls do not move.
// Run from packages/es-app: node test/backend-status.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const now = Date.now()
const base = { projectID: "fixture", version: "1", agent: "build" }
preview.fixture.workspaceSessions = [
  { ...base, id: "ses_old", title: "Legacy importer cleanup", directory, time: { created: now - 9 * 86400_000, updated: now - 3 * 86400_000 } },
]
preview.fixture.failures = [{ sessionID: "ses_old", directory, messageID: "msg_old", parentID: "msg_u2", time: now - 3600_000, error: { name: "ProviderAuthError" }, retry: "unsafe" }]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", error => errors.push(error.message))

// Fault modes for the app's read proxies. Writes and event streams pass.
let mode = "pass"
const refused = new Set()
await page.route(/\/(oc|es\/api)\//, route => {
  const request = route.request()
  const url = new URL(request.url())
  if (request.method() !== "GET" || url.pathname.endsWith("/event") || url.pathname.includes("/events")) return route.continue()
  if ([...refused].some(path => url.pathname.endsWith(path))) return route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"forbidden"}' })
  if (mode === "502") return route.fulfill({ status: 502, contentType: "application/json", body: `{"error":"attached service unavailable","url":"${url.href}"}` })
  if (mode === "offline") return route.abort("connectionrefused")
  return route.continue()
})

const queue = page.getByRole("complementary", { name: "Desk queue" })
const indicator = page.locator(".backend-status")
const warnings = page.locator(".home-warning, .err, [role=alert]")
const box = async locator => { const value = await locator.boundingBox(); return value && [value.x, value.y, value.width, value.height].map(Math.round) }
const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click()
try {
  await page.goto(preview.url, { timeout: 90_000 })
  const heading = queue.getByRole("heading", { name: /^Needs you \d+$/ })
  // The request check lands after the first paint; wait for a settled count.
  await expect(heading).toHaveText("Needs you 4")
  const healthy = await heading.textContent()
  await expect(indicator.locator("button")).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  const header = await box(page.locator(".mode-switch").first())
  const queueBox = await box(queue)
  const headingBox = await box(heading)
  const healthyWarnings = await warnings.count()

  // A burst of failed refreshes under 502, then offline.
  mode = "502"
  for (let index = 0; index < 4; index++) { await refresh(); await page.waitForTimeout(300) }
  mode = "offline"
  for (let index = 0; index < 4; index++) { await refresh(); await page.waitForTimeout(300) }
  await expect(indicator).toHaveAttribute("data-state", "updating", { timeout: 5000 })
  await expect(indicator.locator("button")).toHaveCount(1)
  expect(await warnings.count()).toBe(healthyWarnings)
  await expect(page.locator("main")).not.toContainText(/https?:\/\/|\{"|HTTP 502/)
  await expect(heading).toHaveText(healthy)
  expect(await box(page.locator(".mode-switch").first())).toEqual(header)
  expect(await box(queue)).toEqual(queueBox)
  expect(await box(heading)).toEqual(headingBox)
  // Detail is one click away, out of flow, sanitized.
  await indicator.locator("button").click()
  const panel = page.getByRole("dialog", { name: "Diagnostics" })
  await expect(panel).toContainText(/no connection|service unavailable/)
  await expect(panel).not.toContainText(/https?:\/\/|\{"/)
  expect(await box(queue)).toEqual(queueBox)
  await page.keyboard.press("Escape")
  await page.mouse.click(5, 895)
  console.info("PASS 502/offline refresh bursts: one header indicator, no new warning cards, no raw detail, stable geometry, count unchanged")

  // Recovery clears it; a refused ignored-failures read is reported as a problem, not hidden.
  mode = "pass"
  await refresh()
  await expect(indicator.locator("button")).toHaveCount(0, { timeout: 10000 })
  refused.add("/frontdesk/ignored-failures")
  await page.reload()
  await expect(heading).toBeVisible()
  await expect(indicator).toHaveAttribute("data-state", "problem", { timeout: 6000 })
  await indicator.locator("button").click()
  await expect(page.getByRole("dialog", { name: "Diagnostics" })).toContainText("Ignored failures")
  await expect(page.getByRole("dialog", { name: "Diagnostics" })).toContainText("not authorized (HTTP 403)")
  expect(await warnings.count()).toBe(healthyWarnings)
  console.info("PASS 403 on ignored failures shows as a problem in the shared indicator, without a warning card")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

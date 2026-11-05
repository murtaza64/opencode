// DD #897/#899: this page's own origin behind Cloudflare Access with an expired session. Access answers XHR-marked
// requests with a non-JSON 401: the page shows one "Sign in" bar above the composer (not offline, not re-pair), the
// editor keeps working, a Send waits without any POST, and goes once when requests succeed again.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const headers = []
const editor = () => page.locator(".prompt-box:not([inert])").getByRole("textbox", { name: "Message", exact: true })
const bar = page.locator(".access-sign-in")
const posts = () => fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/prompt_async"))
// Access, expired: every API read or write gets its 401 (text/html), as Cloudflare answers an XHR-marked request.
const expire = (route) => {
  headers.push(route.request().headers()["x-requested-with"] ?? null)
  return route.fulfill({ status: 401, contentType: "text/html", body: "<html>Unauthorized</html>" })
}
try {
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(editor()).toBeVisible()
  await expect(bar).toHaveCount(0)
  await page.route(/\/(oc|es)\//, expire)
  await expect(bar).toBeVisible({ timeout: 15_000 })
  await expect(bar).toContainText("Sign-in expired")
  await expect(bar.getByRole("button", { name: "Sign in" })).toBeVisible()
  expect(headers.length).toBeGreaterThan(0)
  expect(headers.every((value) => value === "XMLHttpRequest")).toBe(true)
  const before = posts().length
  await editor().fill("held while signed out")
  await page.locator(".prompt-box").getByRole("button", { name: "Send", exact: true }).click()
  await expect(editor()).toHaveValue("")
  await page.waitForTimeout(1500)
  expect(posts().length).toBe(before)
  await editor().fill("still typing")
  await page.screenshot({ path: process.env.SHOT ?? "/tmp/access-sign-in.png" })
  // Signed in again: the next successful read clears the bar and the held Send goes, once.
  await page.unroute(/\/(oc|es)\//, expire)
  await expect(bar).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => posts().length, { timeout: 15_000 }).toBe(before + 1)
  await page.waitForTimeout(1000)
  expect(posts().length).toBe(before + 1)
  await expect(editor()).toHaveValue("still typing")
  expect(errors).toEqual([])
  console.log("PASS access sign-in: bar on Access 401s with X-Requested-With, typing kept, Send held with no POST, sent once after sign-in")
} finally {
  await browser.close()
  await preview.close()
}

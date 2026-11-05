// DD #922: long-lived upstream streams a typical page holds. Opens a session, two more sessions, back to the first, then
// hides the page. Prints the fixture's open upstream event streams at each step (each = one long-lived connection the
// mux or a native EventSource holds). Asserts the shared-subscription contract on current code.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
fixture.sessionIDs.push("ses_c", "ses_d")
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const href = (id) => `${preview.origin}/session/${id}?directory=${encodeURIComponent(directory)}`
const streams = () => [...fixture.eventStreams.values()].map((stream) => `${stream.path}${stream.directory ? `?dir` : ""}`).sort()
const counts = {}
const settle = () => page.waitForTimeout(800)
try {
  await page.goto(href("ses_a"))
  await expect(page.locator(".prompt-box").first()).toBeVisible()
  await settle()
  counts.one = streams()
  for (const id of ["ses_b", "ses_c", "ses_a"]) {
    await page.locator(`.sidebar a[href*="/session/${id}"]`).first().click()
    await settle()
  }
  counts.afterThree = streams()
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await settle()
  counts.hidden = streams()
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await settle()
  counts.shown = streams()
  console.log(JSON.stringify(Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, { total: value.length, streams: value }])), null, 1))
  if (process.env.ASSERT !== "0") {
    // All sessions share one directory: one directory stream however many were visited, nothing while hidden.
    expect(counts.afterThree.filter((path) => path === "/event?dir").length).toBeLessThanOrEqual(1)
    expect(counts.hidden).toEqual([])
    expect(counts.shown.length).toBeGreaterThan(0)
  }
  expect(errors).toEqual([])
  console.log("PASS stream count")
} finally {
  await browser.close()
  await preview.close()
}

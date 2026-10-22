import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.setStatus("idle")
const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  for (const options of [{ viewport: { width: 1440, height: 1000 } }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]) {
    const context = await browser.newContext(options)
    const page = await context.newPage()
    await page.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    await page.goto(preview.url, { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Refresh availability", exact: true })).toHaveCount(0)
    // The model action and the primary send button keep their place when the session turns busy.
    const geometry = () => page.locator(".prompt-box .direct-send").evaluate((el) => [".direct-change-model", ".direct-primary", ".direct-more"]
      .map((selector) => { const r = el.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }))
    // Measure once loading feedback below the bar has cleared.
    await expect(page.locator(".prompt-box .direct-feedback")).toHaveCount(0)
    const idle = await geometry()
    await expect(page.getByRole("button", { name: "More send options", exact: true })).toHaveCount(0)
    preview.fixture.setStatus("busy")
    await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "More send options", exact: true })).toBeVisible()
    await expect.poll(geometry).toEqual(idle)
    preview.fixture.setStatus("idle")
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible()
    await expect.poll(geometry).toEqual(idle)
    await context.close()
  }
  expect(preview.fixture.calls.filter((call) => call.method !== "GET")).toEqual([])
  console.log("PASS stationary model action and send button: idle→busy→idle, desktop and mobile/touch; no submissions")
} finally { await preview.close(); await browser.close() }

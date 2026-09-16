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
    const geometry = () => page.locator(".direct-controls").evaluate((el) => ({
      dropdowns: [...el.querySelectorAll("select")].map((select) => { const r = select.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] }),
      actions: el.querySelector(".direct-submit-actions").getBoundingClientRect().y,
    }))
    const idle = await geometry()
    expect(idle.dropdowns).toHaveLength(2)
    expect(idle.actions).toBeGreaterThanOrEqual(idle.dropdowns[1][1] + idle.dropdowns[1][3])
    preview.fixture.setStatus("busy")
    await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible()
    expect(await geometry()).toEqual(idle)
    preview.fixture.setStatus("idle")
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible()
    expect(await geometry()).toEqual(idle)
    await context.close()
  }
  expect(preview.fixture.calls.filter((call) => call.method !== "GET")).toEqual([])
  console.log("PASS stationary dropdowns above action row: idle→busy→idle, desktop and mobile/touch; no submissions")
} finally { await preview.close(); await browser.close() }

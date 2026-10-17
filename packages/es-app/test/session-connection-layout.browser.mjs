import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })

try {
  for (const direction of ["ltr", "rtl"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await page.goto(preview.url)
      await page.evaluate((dir) => { document.documentElement.dir = dir }, direction)
      const status = page.locator(".session-work-status")
      const composer = page.locator(".direct-composer:visible")
      await expect(status).toHaveAttribute("data-state", "working")
      await expect(composer).toBeVisible()
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      const before = await composer.boundingBox()
      preview.fixture.failSnapshot = true
      preview.fixture.disconnect()
      await expect(status).toHaveAttribute("data-state", "disconnected")
      await expect(status).toHaveAttribute("title", /Session connection lost|Unable to load session/)
      await expect(page.locator(".session-alerts")).not.toContainText(/Session connection lost|Unable to load session/)
      await expect(composer).not.toContainText("Session unavailable")
      const after = await composer.boundingBox()
      expect(after.y).toBe(before.y)
      expect(after.height).toBe(before.height)
      await expect(status.getByRole("button", { name: "reconnect" })).toBeVisible()
      console.info(`PASS ${direction} connection loss preserves composer geometry and offers reconnect`)
    } finally {
      preview.fixture.failSnapshot = false
      await page.close()
    }
  }
} finally {
  await browser.close()
  await preview.close()
}

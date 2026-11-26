// The "g d" row in keyboard help and the which-key popup reads "Go to Porter" on a Work page and
// "Go to Front desk" on a Personal page. Disposable fixture. Run from packages/es-app: node test/keyboard-desk-label.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
try {
  for (const [profile, label, other] of [["work", "Go to Porter", "Go to Front desk"], ["personal", "Go to Front desk", "Go to Porter"]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "here", label: "Here", remote: false, profile, hosts: [], work: [] } }))
    await page.goto(`${preview.origin}/usage`, { waitUntil: "domcontentloaded", timeout: 180_000 })
    await page.waitForTimeout(1500)
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await page.keyboard.press("Shift+Slash")
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" })
    await expect(help.locator(".kbd-row", { hasText: "g d" })).toContainText(label)
    await expect(help.getByText(other, { exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await page.keyboard.press("g")
    await expect(page.locator(".kbd-which-key")).toContainText(label)
    await page.keyboard.press("Escape")
    console.log(`ok ${profile}: ${label}`)
    await context.close()
  }
  expect(errors).toEqual([])
  console.log("PASS g d help label: Porter on Work, Front desk on Personal (help overlay and which-key)")
} finally {
  await browser.close()
  await preview.close()
}

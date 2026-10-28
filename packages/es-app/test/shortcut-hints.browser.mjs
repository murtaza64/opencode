import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
// Hints name the chord each platform's handler accepts; aria-keyshortcuts lists every accepted chord.
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
try {
  for (const [platform, send] of [["MacIntel", "⌘↵"], ["Linux x86_64", "Ctrl+Enter"]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript((value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }), platform)
    await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
    const steer = page.locator(".prompt-box:not([inert])").getByRole("button", { name: "Steer", exact: true })
    await expect(steer.locator("kbd")).toHaveText(send)
    await expect(steer).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter")
    const find = page.getByRole("button", { name: "Find", exact: true })
    await expect(find).toHaveAttribute("title", `Find in transcript (${platform === "MacIntel" ? "⌘F" : "Ctrl+F"})`)
    await expect(page.getByRole("button", { name: "Previous prompt", exact: true })).toHaveAttribute("aria-keyshortcuts", "Control+P")
    console.log(`ok ${platform}: ${send}`)
    await context.close()
  }
} finally {
  await browser.close()
  await preview.close?.()
}

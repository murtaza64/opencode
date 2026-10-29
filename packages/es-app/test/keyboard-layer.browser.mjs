// App-wide keys: "?" overlay lists only dispatched bindings with platform labels,
// g sequences navigate in place, F6 cycles regions, and text entry keeps letters.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const session = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
try {
  for (const [platform, find, region] of [["MacIntel", "⌘F", "F6"], ["Linux x86_64", "Ctrl+F", "F6"]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript((value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }), platform)
    await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(session, { waitUntil: "domcontentloaded", timeout: 180_000 })
    await page.locator(".prompt-box textarea").waitFor()

    // Typing "?" and "g" in the composer stays text.
    await page.locator(".prompt-box textarea").focus()
    await page.keyboard.press("i")
    await page.keyboard.type("g?")
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0)

    // Outside text entry, "?" opens the overlay; it lists dispatched keys only.
    await page.locator(".transcript").click({ position: { x: 5, y: 5 } })
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await page.keyboard.press("Shift+Slash")
    const overlay = page.getByRole("dialog", { name: "Keyboard shortcuts" })
    await expect(overlay).toBeVisible()
    await expect(overlay.getByText(find, { exact: true })).toBeVisible()
    await expect(overlay.getByText("g C", { exact: true })).toBeVisible()
    await expect(overlay.getByText(region, { exact: true })).toBeVisible()
    await expect(overlay.getByText("Command palette")).toHaveCount(0)
    await expect(overlay.getByText("Session finder")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(overlay).toHaveCount(0)

    // Leader shows which-key after a pause; an unbound key cancels with no effect.
    await page.keyboard.press("Space")
    await expect(page.locator(".kbd-which-key")).toBeVisible()
    await page.keyboard.press("z")
    await expect(page.locator(".kbd-which-key")).toHaveCount(0)

    // g u navigates in place.
    await page.evaluate(() => { window.kbdMarker = "same-document" })
    await page.keyboard.press("g")
    await page.keyboard.press("u")
    await expect.poll(() => new URL(page.url()).pathname).toBe("/usage")
    expect(await page.evaluate(() => window.kbdMarker)).toBe("same-document")

    // F6 moves focus between regions.
    await page.goto(session, { waitUntil: "domcontentloaded" })
    await page.locator(".prompt-box textarea").focus()
    await page.keyboard.press("F6")
    const inComposer = await page.evaluate(() => !!document.activeElement?.closest(".prompt-box"))
    expect(inComposer).toBe(false)
    expect(errors).toEqual([])
    console.log(`ok ${platform}`)
    await context.close()
  }
} finally {
  await browser.close()
  await preview.close?.()
}

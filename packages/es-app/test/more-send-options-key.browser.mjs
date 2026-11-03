// Cmd/Ctrl+M opens More send options on a busy session and focuses its first choice; Esc closes it
// and returns focus to the composer; Cmd/Ctrl+M again closes it; idle does nothing; the saved
// keyboard target never changes. Disposable fixture. Run from packages/es-app: node test/more-send-options-key.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
try {
  for (const [platform, chord] of [["MacIntel", "Meta+m"], ["Linux x86_64", "Control+m"]]) {
    fixture.setStatus("busy")
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }), platform)
    await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
    const box = page.locator(".prompt-box:not([inert]) textarea")
    await box.waitFor({ timeout: 60_000 })
    const more = page.locator(".prompt-box:not([inert]) button.direct-more")
    await expect(more).toBeEnabled()
    const menu = page.locator(".prompt-box:not([inert]) .direct-more-menu")
    const target = () => page.evaluate(() => localStorage.length && JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([key]) => /target|composer/i.test(key)))))
    await box.focus()
    await box.fill("a queued thought")
    const before = await target()

    await page.keyboard.press(chord)
    await expect(menu).toBeVisible()
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".direct-more-menu"))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches(".prompt-box textarea"))).toBe(true)
    await expect(box).toHaveValue("a queued thought")

    await page.keyboard.press(chord)
    await expect(menu).toBeVisible()
    await page.keyboard.press(chord)
    await expect(menu).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches(".prompt-box textarea"))).toBe(true)
    expect(await target(), "the saved keyboard target is unchanged").toBe(before)

    // Help lists the platform chord with its new meaning.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await page.keyboard.press("Shift+Slash")
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" })
    await expect(help.getByText(platform === "MacIntel" ? "⌘M" : "Ctrl+M", { exact: true })).toBeVisible()
    await expect(help.getByText("More send options (queue, aside) while busy")).toBeVisible()
    await expect(help.getByText("Cycle steer, queue, aside")).toHaveCount(0)
    await page.keyboard.press("Escape")

    // Idle: the menu is unavailable and the chord does nothing.
    fixture.setStatus("idle")
    await expect(more).toBeDisabled()
    await box.focus()
    await page.keyboard.press(chord)
    await page.waitForTimeout(300)
    await expect(menu).toHaveCount(0)
    console.log(`ok ${platform}`)
    await context.close()
  }
  expect(errors).toEqual([])
  console.log("PASS Cmd/Ctrl+M: opens More send options when busy with focus on its first choice; Esc closes and refocuses the composer; the chord closes it too; idle does nothing; help lists the new meaning")
} finally {
  await browser.close()
  await preview.close()
}

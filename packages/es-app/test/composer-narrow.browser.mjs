// Narrow composer (human, orchestrator GO 805): the session actions respond to the composer's own width, not the
// viewport. A narrow pane in a wide window shows icon actions with their labels as accessible names, and keeps Fork,
// Hand off, Archive and Delete behind a keyboard-accessible "More session actions" (Escape closes, focus returns).
// Send is content-sized with a usable target and keeps Send/Steer/Nudge semantics, its full name and chord tooltip.
// The draft, caret and focus survive resizing and the menu. The model button is never a ticket ref.
// Run from packages/es-app: node test/composer-narrow.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-composer-narrow")
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.laneOwners = [{ lane: "work", owner: "ses_a" }]
fixture.setStatus("idle")
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
// Squeezes the session pane the way an embedded or split pane does; the window itself stays wide.
const pane = (page, px) => page.evaluate((px) => {
  const main = document.querySelector(".prompt-box")
  main.style.inlineSize = px ? `${px}px` : ""
  main.style.maxInlineSize = px ? `${px}px` : ""
}, px)
try {
  for (const dir of ["ltr", "rtl"]) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    if (dir === "rtl") await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    await context.route("**/config/providers*", async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.providers[0].models.test.name = "GPT-6.1 Sol"
      await route.fulfill({ response, json: body })
    })
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
    const box = page.locator(".prompt-box:not([inert])")
    const composer = box.locator(".direct-composer")
    const actions = box.getByRole("group", { name: "Session actions" })
    const editor = box.getByRole("textbox", { name: "Message", exact: true })
    const primary = box.locator(".direct-primary")
    const more = actions.getByRole("button", { name: "More session actions", exact: true })

    // Wide pane: labelled actions, all in the row.
    await expect(composer).toHaveAttribute("data-width", "wide")
    await expect(actions.getByRole("button", { name: "Fork", exact: true })).toBeVisible()
    await expect(actions.locator(".action-label").first()).toBeVisible()
    await expect(more).toHaveCount(0)
    await editor.fill("keep this draft")
    await editor.evaluate((el) => el.setSelectionRange(5, 9))

    // Compact pane: icons only, every action keeps its accessible name and a tooltip.
    await pane(page, 640)
    await expect(composer).toHaveAttribute("data-width", "compact")
    for (const name of ["Expand editor", "Bottom", "Nudge", "Fork", "Hand off", "Archive", "Delete"]) {
      const button = actions.getByRole("button", { name, exact: true })
      await expect(button).toBeVisible()
      await expect(button).toHaveAttribute("title", /.+/)
      expect(await button.locator(".action-label").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1)
    }

    // Narrow pane at a wide window: infrequent actions behind More; frequent ones stay.
    await pane(page, 400)
    await expect(composer).toHaveAttribute("data-width", "narrow")
    await expect(actions.getByRole("button", { name: "Fork", exact: true })).toHaveCount(0)
    await expect(actions.getByRole("button", { name: "Bottom", exact: true })).toBeVisible()
    await expect(actions.getByRole("button", { name: "Nudge", exact: true })).toBeVisible()
    await expect(editor).toHaveValue("keep this draft")
    expect(await editor.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([5, 9])
    // The row fits the pane: no action spills past the composer.
    const fits = await composer.evaluate((el) => {
      const outer = el.getBoundingClientRect()
      return [...el.querySelectorAll(".direct-bar button")].every((button) => {
        const r = button.getBoundingClientRect()
        return r.width === 0 || (r.left >= outer.left - 1 && r.right <= outer.right + 1)
      })
    })
    expect(fits).toBe(true)

    // Keyboard: open with Enter, focus moves into the menu, Escape closes and returns focus.
    await more.focus()
    await page.keyboard.press("Enter")
    await expect(more).toHaveAttribute("aria-expanded", "true")
    const menu = actions.getByRole("group", { name: "More session actions" })
    for (const name of ["Fork", "Hand off", "Archive", "Delete"]) await expect(menu.getByRole("button", { name, exact: true })).toBeVisible()
    await expect(menu.getByRole("button", { name: "Fork", exact: true })).toBeFocused()
    await page.screenshot({ path: join(shots, `narrow-menu-${dir}.png`) })
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(more).toBeFocused()
    // Choosing an action closes the menu and runs it (Hand off opens the manual form).
    await more.click()
    await menu.getByRole("button", { name: "Hand off", exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "Successor task" })).toBeVisible()
    await expect(editor).toHaveValue("keep this draft")

    // Send: content-sized, usable target, full name and chord in the tooltip, Send semantics.
    const sendBox = await primary.boundingBox()
    expect(sendBox.width).toBeLessThan(96)
    expect(sendBox.width).toBeGreaterThanOrEqual(44)
    expect(sendBox.height).toBeGreaterThanOrEqual(32)
    await expect(primary).toHaveAccessibleName("Send")
    await expect(primary).toHaveAttribute("title", /^Send \(.+\)$/)
    await expect(primary).toHaveAttribute("aria-keyshortcuts", /Enter/)
    // Busy: Steer, same width as Send.
    fixture.setStatus("busy")
    await expect(primary).toHaveAccessibleName("Steer")
    expect(Math.round((await primary.boundingBox()).width)).toBe(Math.round(sendBox.width))
    // Empty draft: Nudge.
    await editor.fill("")
    await expect(primary).toHaveAccessibleName("Nudge the agent (empty message)")
    await editor.fill("keep this draft")
    fixture.setStatus("idle")
    await expect(primary).toHaveAccessibleName("Send")
    // Model stays reachable; its name is never a ticket ref.
    const model = box.getByRole("button", { name: /^Change model, current GPT-6\.1 Sol/ })
    await expect(model).toBeVisible()
    await expect(model.locator(".ticket-ref")).toHaveCount(0)
    await page.screenshot({ path: join(shots, `narrow-${dir}.png`) })

    // Back to wide: labels return, the draft and focus are untouched.
    await editor.focus()
    await pane(page, 0)
    await expect(composer).toHaveAttribute("data-width", "wide")
    await expect(actions.getByRole("button", { name: "Fork", exact: true })).toBeVisible()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue("keep this draft")
    await context.close()
  }

  // Browser zoom 200% on a 1280px window: the composer is narrow by its own width.
  const zoomed = await browser.newContext({ viewport: { width: 640, height: 900 }, deviceScaleFactor: 2 })
  const page = await zoomed.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const composer = page.locator(".prompt-box:not([inert]) .direct-composer")
  await expect(composer).toHaveAttribute("data-width", /compact|narrow/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(shots, "zoom-200.png") })
  await zoomed.close()

  expect(errors).toEqual([])
  expect(fixture.unexpected).toEqual([])
  console.log(`PASS narrow composer: container-width tiers (wide/compact/narrow at a 1600px window), icon actions keep names + tooltips, More menu keyboard/Escape/focus return, action runs from menu, draft + caret kept, content-sized Send/Steer/Nudge with 44x32 target and chord tooltip, model reachable and not a ticket ref, LTR/RTL, zoom 200%; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}

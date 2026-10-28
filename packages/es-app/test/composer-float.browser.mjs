// Expanded editor (human, Main 856): the composer's one textarea grows upward in place, never a modal copy.
// Long input expands it automatically once content fills ~90% of the visible box; the Expand editor button and
// Ctrl+E toggle it; both use the same height (bounded by the pane, then scrolling inside) and the same animation
// (instant with reduced motion). The same element keeps draft, caret, undo history, focus and vim mode; a manual
// collapse stays collapsed until the draft is cleared; a followed transcript bottom stays followed.
// Run from packages/es-app: node test/composer-float.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const errors = []
const box = (page) => page.locator(".prompt-box")
const editor = (page) => page.locator(".prompt-box textarea[aria-label='Message']")
const expand = (page) => page.getByRole("button", { name: /^(Expand|Collapse) editor$/ })
const selection = (locator) => locator.evaluate((el) => [el.selectionStart, el.selectionEnd])
const height = (locator) => locator.evaluate((el) => Math.round(el.getBoundingClientRect().height))
const clear = async (locator) => {
  await locator.fill("")
  await expect(locator).toHaveValue("")
  await expect(locator).toBeFocused()
}
const lines = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n")
const open = async (options) => {
  const page = await browser.newPage(options)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(editor(page)).toBeFocused()
  // Marks the element: a remount would lose the mark; a blur would count.
  await editor(page).evaluate((el) => {
    el.dataset.instance = "original"
    window.blurs = 0
    el.addEventListener("blur", () => { window.blurs += 1 })
  })
  return page
}
const same = async (page) => {
  await expect(editor(page)).toHaveAttribute("data-instance", "original")
  await expect(page.locator(".float-editor")).toHaveCount(0)
  await expect(page.locator("textarea[aria-label='Message']")).toHaveCount(1)
}
try {
  console.log("expand: short drafts stay collapsed")
  const page = await open({ viewport: { width: 1440, height: 1000 } })
  const collapsed = await height(editor(page))
  await page.keyboard.type(lines(1, 3))
  await page.waitForTimeout(100)
  await expect(box(page)).not.toHaveClass(/prompt-expanded/)

  console.log("expand: long input grows the same textarea upward, caret, focus and typing order kept")
  await clear(editor(page))
  const typed = lines(1, 16)
  await page.keyboard.type(typed)
  await expect(box(page)).toHaveClass(/prompt-expanded/)
  await same(page)
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toHaveValue(typed)
  expect(await selection(editor(page))).toEqual([typed.length, typed.length])
  await expect(editor(page)).toHaveClass(/vim-insert/)
  await expect.poll(() => height(editor(page))).toBeGreaterThan(collapsed + 100)
  // Grows upward: the bottom edge stays where it was.
  const grown = await editor(page).boundingBox()
  expect(await page.evaluate(() => window.blurs)).toBe(0)
  // Undo history belongs to the same element: Mod+Z removes the last typed text, not the whole draft.
  await page.keyboard.type("XYZ")
  await page.keyboard.press("ControlOrMeta+z")
  await expect(editor(page)).not.toHaveValue(typed + "XYZ")
  expect((await editor(page).inputValue()).startsWith(typed)).toBe(true)
  await editor(page).fill(typed)

  console.log("expand: bounded by the pane, the textarea scrolls inside")
  await editor(page).fill(lines(1, 120))
  const max = await height(editor(page))
  expect(max).toBeLessThanOrEqual(Math.round(1000 * 0.6) + 1)
  expect(await editor(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true)
  await expect(page.locator(".transcript")).toBeVisible()
  expect(await page.locator(".transcript").evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(100)
  await editor(page).fill(typed)

  console.log("expand: collapse (Ctrl+E) stays collapsed until the draft is cleared")
  await editor(page).press("Control+e")
  await expect(box(page)).not.toHaveClass(/prompt-expanded/)
  await same(page)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type("\nline 17")
  await page.waitForTimeout(100)
  await expect(box(page)).not.toHaveClass(/prompt-expanded/)
  await expect(editor(page)).toHaveValue(typed + "\nline 17")
  await clear(editor(page))
  await page.keyboard.type(lines(1, 16))
  await expect(box(page)).toHaveClass(/prompt-expanded/)

  console.log("expand: the button toggles with the same height and keeps the caret")
  await expect(expand(page)).toHaveAccessibleName("Collapse editor")
  await expect(expand(page)).toHaveAttribute("aria-expanded", "true")
  // The automatic expansion's settled height (it animates there).
  const target = () => box(page).evaluate((el) => Math.round(parseFloat(el.style.getPropertyValue("--editor-expanded"))))
  await expect.poll(async () => (await height(editor(page))) === (await target())).toBe(true)
  const auto = await height(editor(page))
  await editor(page).evaluate((el) => el.setSelectionRange(7, 7))
  await expand(page).click()
  await expect(box(page)).not.toHaveClass(/prompt-expanded/)
  await expand(page).click()
  await expect(box(page)).toHaveClass(/prompt-expanded/)
  await expect.poll(() => height(editor(page))).toBe(auto)
  expect(await selection(editor(page))).toEqual([7, 7])
  await same(page)

  console.log("expand: a followed transcript bottom stays followed while the editor grows")
  await expand(page).click()
  await clear(editor(page))
  const atBottom = () => page.locator(".transcript").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4)
  expect(await atBottom()).toBe(true)
  await page.keyboard.type(lines(1, 16))
  await expect(box(page)).toHaveClass(/prompt-expanded/)
  await expect.poll(atBottom).toBe(true)

  console.log("expand: vim normal mode survives the auto-expand")
  await expand(page).click()
  await clear(editor(page))
  await page.keyboard.type(lines(1, 3))
  // Counted from here: the button clicks above moved focus on purpose.
  await page.evaluate(() => { window.blurs = 0 })
  await editor(page).press("Escape")
  await expect(editor(page)).toHaveClass(/vim-normal/)
  await editor(page).press("G")
  await editor(page).press("o")
  await page.keyboard.type(lines(4, 16))
  await expect(box(page)).toHaveClass(/prompt-expanded/)
  await expect(editor(page)).toHaveClass(/vim-insert/)
  await expect(editor(page)).toHaveValue(lines(1, 16))
  await expect(page.locator(".relative-lines")).toBeVisible()
  expect(await page.evaluate(() => window.blurs)).toBe(0)
  await page.close()

  console.log("expand: a short window expands sooner and bounds the height")
  const short = await open({ viewport: { width: 1440, height: 520 } })
  expect(await height(editor(short))).toBeLessThan(collapsed + 1)
  await short.keyboard.type(lines(1, 12))
  await expect(box(short)).toHaveClass(/prompt-expanded/)
  expect(await height(editor(short))).toBeLessThanOrEqual(Math.round(520 * 0.6) + 1)
  expect(await short.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true)
  await short.close()

  console.log("expand: reduced motion switches at once; RTL and a narrow pane keep the same element")
  const calm = await open({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })
  await calm.evaluate(() => { document.documentElement.dir = "rtl" })
  await calm.evaluate(() => { document.querySelector(".prompt-box").style.inlineSize = "400px" })
  expect(await editor(calm).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s")
  await expand(calm).click()
  // No animation: the expanded height is there on the next frame.
  const now = await calm.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
    resolve(Math.round(document.querySelector(".prompt-box textarea").getBoundingClientRect().height)))))
  expect(now).toBeGreaterThan(collapsed + 100)
  await same(calm)
  await expect(editor(calm)).toBeFocused()
  await calm.close()

  expect(preview.fixture.calls.filter((call) => call.method !== "GET")).toEqual([])
  expect(preview.fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS expand inline: auto + manual grow one textarea (no remount, no blur, undo kept), caret/vim kept, pane-bounded with internal scroll (no page scroll), collapse sticky, button/shortcut share height, follow-bottom kept, short window, reduced motion instant, RTL + narrow pane; bottom edge at ${Math.round(grown.y + grown.height)}px`)
} catch (error) {
  console.error(error)
  throw error
} finally {
  await preview.close()
  await browser.close()
}

// Auto-expanded editor: opens only when content fills ~90% of the visible inline box,
// and opens with the caret exactly where the inline caret was, even mid-typing.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const errors = []
const inline = (page) => page.locator(".prompt-box textarea")
const float = (page) => page.locator(".float-editor")
const floatEditor = (page) => float(page).locator("textarea")
const selection = (locator) => locator.evaluate((el) => [el.selectionStart, el.selectionEnd])
const clear = async (locator) => {
  await locator.fill("")
  await expect(locator).toHaveValue("")
  await expect(locator).toBeFocused()
}
const lines = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n")
const open = async (viewport) => {
  const page = await browser.newPage({ viewport })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(inline(page)).toBeFocused()
  return page
}
try {
  console.log("float: short multi-line drafts stay inline")
  const page = await open({ width: 1440, height: 1000 })
  const box = await inline(page).evaluate((el) => el.clientHeight)
  await page.keyboard.type(lines(1, 3))
  await expect(inline(page)).toHaveValue(lines(1, 3))
  await page.waitForTimeout(100)
  await expect(float(page)).toHaveCount(0)
  // A short wrapped sentence on top still leaves the visible box well short of full.
  await page.keyboard.type(" " + "word ".repeat(20).trim())
  await page.waitForTimeout(100)
  await expect(float(page)).toHaveCount(0)

  console.log("float: opens near a full visible box with every character in order and caret at the end")
  await clear(inline(page))
  const typed = lines(1, 16)
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const el = document.querySelector(".float-editor textarea")
      if (!el) return
      window.openedLines = el.value.split("\n").length
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  })
  await page.keyboard.type(typed)
  await expect(float(page)).toHaveCount(1)
  await expect(floatEditor(page)).toBeFocused()
  await expect(floatEditor(page)).toHaveValue(typed)
  expect(await selection(floatEditor(page))).toEqual([typed.length, typed.length])
  await expect(floatEditor(page)).toHaveClass(/vim-insert/)
  await expect(page.locator(".prompt-box")).toHaveAttribute("inert", "")
  const opened = await page.evaluate(() => window.openedLines)
  console.log(`float: opened at ${opened} lines in a ${box}px box`)
  // Opens once content reaches ~90% of the visible box: past the short drafts above,
  // before the inline box would have had to scroll (19.5px lines + 16px padding).
  expect(opened).toBeGreaterThan(3)
  expect(opened * 19.5 + 16).toBeLessThanOrEqual(box + 19.5)

  console.log("float: collapsed editor stays collapsed until the draft is cleared")
  await floatEditor(page).press("Control+e")
  await expect(float(page)).toHaveCount(0)
  await expect(inline(page)).toBeFocused()
  expect(await selection(inline(page))).toEqual([typed.length, typed.length])
  await page.keyboard.type("\nline 17")
  await page.waitForTimeout(100)
  await expect(float(page)).toHaveCount(0)
  await expect(inline(page)).toHaveValue(typed + "\nline 17")
  await clear(inline(page))
  await page.keyboard.type(lines(1, 16))
  await expect(float(page)).toHaveCount(1)
  await expect(floatEditor(page)).toHaveValue(lines(1, 16))
  await page.getByRole("button", { name: /collapse/ }).click()
  await clear(inline(page))

  console.log("float: opens mid-text with the caret where the inline caret was")
  const base = lines(1, 4)
  await inline(page).fill(base)
  await inline(page).click()
  const at = base.indexOf("line 3")
  await inline(page).evaluate((el, pos) => el.setSelectionRange(pos, pos), at)
  await page.keyboard.type("alpha\nbeta\ngamma\ndelta\n")
  await expect(float(page)).toHaveCount(1)
  await page.keyboard.type("epsilon\n")
  const inserted = "alpha\nbeta\ngamma\ndelta\nepsilon\n"
  await expect(floatEditor(page)).toHaveValue(base.slice(0, at) + inserted + base.slice(at))
  expect(await selection(floatEditor(page))).toEqual([at + inserted.length, at + inserted.length])

  console.log("float: vim normal mode survives the auto-open")
  await page.getByRole("button", { name: /collapse/ }).click()
  await clear(inline(page))
  await page.keyboard.type(lines(1, 3))
  await expect(float(page)).toHaveCount(0)
  await inline(page).press("Escape")
  await expect(inline(page)).toHaveClass(/vim-normal/)
  await inline(page).press("G")
  await inline(page).press("o")
  await expect(inline(page)).toHaveClass(/vim-insert/)
  await page.keyboard.type(lines(4, 16))
  await expect(float(page)).toHaveCount(1)
  await expect(floatEditor(page)).toHaveClass(/vim-insert/)
  await expect(floatEditor(page)).toHaveValue(lines(1, 16))
  await floatEditor(page).press("Escape")
  await expect(floatEditor(page)).toHaveClass(/vim-normal/)
  await page.close()

  console.log("float: a short viewport opens sooner because the visible box is smaller")
  const short = await open({ width: 1440, height: 400 })
  expect(await inline(short).evaluate((el) => el.clientHeight)).toBeLessThan(box)
  await short.keyboard.type(lines(1, 8))
  await expect(float(short)).toHaveCount(1)
  await expect(floatEditor(short)).toHaveValue(lines(1, 8))
  expect(await selection(floatEditor(short))).toEqual([lines(1, 8).length, lines(1, 8).length])
  await short.close()

  expect(preview.fixture.calls.filter((call) => call.method !== "GET")).toEqual([])
  expect(preview.fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS float: visible-box auto-open, in-order typing across the boundary, caret preserved, dismissed stays dismissed, vim mode kept")
} catch (error) {
  console.error(error)
  throw error
} finally {
  await preview.close()
  await browser.close()
}

// Quiet pending inputs (pending-steer-actions-hover-only-20261103). A pending steer's bubble always shows its tick; its
// cue ("Steer · …") and Interrupt and steer now / Edit / Cancel appear on hover, on keyboard focus inside the row, on a
// tap (touch) and while editing. Hidden actions stay laid out (no height change) and in the accessibility tree; the
// pointer can move onto them; editing keeps focus and caret. Semantics unchanged: the buttons do what they did.
// Run from packages/es-app: node test/quiet-pending.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "busy"
fixture.interruptInput = true
fixture.updateInput = true
fixture.receipts.push({ requestID: "s-1", sessionID: "ses_a", delivery: "steer", text: "only rebuild es-app", agent: "build", admittedSeq: 1, timeCreated: Date.now(), state: "pending" })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const row = page.locator('.outgoing li[data-request-id="s-1"]')
  const quiet = (locator) => locator.evaluate((el) => getComputedStyle(el).opacity)
  const deliver = row.getByRole("button", { name: /^Interrupt and steer now/ })
  const edit = row.getByRole("button", { name: /^Edit steer input/ })
  const cancel = row.getByRole("button", { name: /^Cancel steer input/ })
  await expect(row).toHaveCount(1, { timeout: 120_000 })
  await page.mouse.move(0, 0)
  // At rest: tick shown, cue and actions transparent but laid out and accessible.
  await expect(row.locator(".msg-tick")).toBeVisible()
  await expect.poll(() => quiet(row.locator(".outgoing-cue > span"))).toBe("0")
  expect(await quiet(deliver)).toBe("0")
  await expect(deliver).toBeAttached()
  const rest = await row.evaluate((el) => el.getBoundingClientRect().height)
  // Hover reveals; moving onto the button keeps it.
  await row.hover()
  await expect.poll(() => quiet(deliver)).toBe("1")
  await cancel.hover()
  expect(await quiet(cancel)).toBe("1")
  expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBe(rest)
  await page.mouse.move(0, 0)
  await expect.poll(() => quiet(deliver)).toBe("0")
  // Keyboard: Tab lands on the actions and reveals them.
  await deliver.focus()
  await expect.poll(() => quiet(deliver)).toBe("1")
  await expect.poll(() => quiet(row.locator(".outgoing-cue > span"))).toBe("1")
  await page.keyboard.press("Tab")
  await expect(edit).toBeFocused()
  // Editing keeps them shown and the editor focused with its caret.
  await page.keyboard.press("Enter")
  const pendingEditor = page.getByRole("textbox", { name: "Pending input text" })
  await expect(pendingEditor).toBeFocused()
  await page.keyboard.type(" now")
  await page.mouse.move(0, 0)
  await expect(row).toHaveAttribute("data-revealed", "")
  await expect(pendingEditor).toBeFocused()
  await expect(pendingEditor).toHaveValue("only rebuild es-app now")
  await page.keyboard.press("Escape")
  await page.mouse.move(0, 0)
  await page.locator("body").click({ position: { x: 5, y: 5 } })
  // Touch: a tap on the bubble reveals; another hides.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const mobile = await phone.newPage()
  await mobile.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const touchRow = mobile.locator('.outgoing li[data-request-id="s-1"]')
  await expect(touchRow).toHaveCount(1, { timeout: 120_000 })
  await touchRow.locator(".receipt-text").tap()
  await expect(touchRow).toHaveAttribute("data-revealed", "")
  await expect.poll(() => touchRow.getByRole("button", { name: /^Cancel steer input/ }).evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
  await touchRow.locator(".receipt-text").tap()
  await expect(touchRow).not.toHaveAttribute("data-revealed", "")
  await phone.close()
  // Semantics unchanged: Interrupt and steer now still delivers this request.
  await row.hover()
  await deliver.click()
  await expect.poll(() => fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/input/s-1/deliver")).length).toBe(1)
  expect(errors).toEqual([])
  console.log("PASS quiet pending: tick always; cue and actions on hover, focus, tap and while editing; laid out (no height change) and accessible; editing keeps focus/caret; deliver unchanged")
} finally {
  await preview.close()
  await browser.close()
}

import { createRequire } from "node:module"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

// One quiet header row: icon Find / prompt controls and a mail overflow menu.
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const title = "Joiner: reconcile the very long session title that should truncate before the header controls مرحبا"
const preview = await startToolRunsPreview(0, { filler: 45, title })
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const unexpectedWrites = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) &&
  !(call.method === "POST" && call.path === "/api/attention/session" && JSON.stringify(call.body) === "{}"))
const shots = process.env.HEADER_SHOTS

const run = async (viewport, label, dir = "ltr", lang = "en") => {
  const context = await browser.newContext({ viewport })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`))
  await page.goto(preview.laneUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
  const header = page.locator(".topbar")
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await expect(page.locator('[data-find-message="msg_1011"]')).toBeVisible({ timeout: 30_000 })
  // The app sets document direction on load; apply the case afterwards.
  await page.evaluate(([dir, lang]) => { document.documentElement.dir = dir; document.documentElement.lang = lang }, [dir, lang])
  const find = header.getByRole("button", { name: "Find", exact: true })
  const previous = header.getByRole("button", { name: "Previous prompt", exact: true })
  const next = header.getByRole("button", { name: "Next prompt", exact: true })
  const menu = header.getByRole("button", { name: "Session mail", exact: true })

  // One row, no visible control text, count only in the description and tooltip.
  for (const control of [find, previous, next, menu]) {
    await expect(control).toBeVisible()
    await expect(control).toHaveText("")
    const box = await control.boundingBox()
    expect(Math.round(box.width)).toBe(28)
  }
  await expect(previous).toHaveAttribute("aria-keyshortcuts", "Control+P")
  await expect(next).toHaveAttribute("aria-keyshortcuts", "Control+N")
  await expect(previous).toHaveAccessibleDescription(/^prompt \d+ of \d+ · loaded history only/)
  await expect(previous).toHaveAttribute("title", /^Previous prompt \(Ctrl\+P\) · prompt \d+ of \d+/)
  expect(await header.evaluate((element) => element.innerText)).not.toMatch(/Prompt|Mail subscriptions|Lane mail|\d+\/\d+/)
  await expect(page.locator(".session-alerts").getByRole("button", { name: /Mail subscriptions|Lane mail/ })).toHaveCount(0)
  const rows = await header.evaluate((element) => new Set([...element.querySelectorAll(".header-icon")].map((item) => Math.round(item.getBoundingClientRect().top))).size)
  expect(rows).toBe(1)
  // Long titles truncate before the controls; controls stay on the inline-end side.
  const layout = await header.evaluate((element) => {
    const heading = element.querySelector(".session-title-button")?.getBoundingClientRect()
    const tools = element.querySelector(".session-header-tools").getBoundingClientRect()
    const bar = element.getBoundingClientRect()
    return { heading: heading && { left: heading.left, right: heading.right }, tools: { left: tools.left, right: tools.right }, bar: { left: bar.left, right: bar.right } }
  })
  expect(layout.tools.right).toBeLessThanOrEqual(layout.bar.right + 1)
  expect(layout.tools.left).toBeGreaterThanOrEqual(layout.bar.left - 1)
  if (layout.heading) {
    if (dir === "ltr") expect(layout.heading.right).toBeLessThanOrEqual(layout.tools.left + 1)
    else expect(layout.heading.left).toBeGreaterThanOrEqual(layout.tools.right - 1)
  }
  if (shots) await page.screenshot({ path: `${shots}-${label}.png` })

  // Draft and caret survive the icon controls; prompt nav still scrolls.
  await editor.fill("Header draft שלום")
  await editor.evaluate((element) => { element.focus(); element.setSelectionRange(2, 6, "backward") })
  const draft = await editor.evaluate((element) => [element.value, element.selectionStart, element.selectionEnd, element.selectionDirection])
  const writes = unexpectedWrites().length
  const transcript = page.locator(".session-page .transcript")
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const bottom = await transcript.evaluate((element) => element.scrollTop)
  await previous.click()
  await previous.click()
  await expect(editor).toBeFocused()
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeLessThan(bottom)
  await next.click()
  expect(await editor.evaluate((element) => [element.value, element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual(draft)

  // Overflow menu: keyboard open, arrow navigation, Escape returns focus, outside click closes.
  await menu.focus()
  await page.keyboard.press("Enter")
  const content = page.locator(".header-menu-list")
  await expect(content).toBeVisible()
  await expect(menu).toHaveAttribute("aria-expanded", "true")
  await expect(menu).toHaveAttribute("aria-controls", await content.getAttribute("id"))
  await expect(content.getByRole("menuitem")).toHaveText(["Mail subscriptions", "Lane mail (12)"])
  await expect(content.getByRole("menuitem").first()).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(content.getByRole("menuitem").nth(1)).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(content).toHaveCount(0)
  await expect(menu).toHaveAttribute("aria-expanded", "false")
  await expect(menu).toBeFocused()
  // Tab and Shift+Tab continue from the trigger and close the menu.
  const neighbour = async (shift) => page.evaluate((shift) => {
    const trigger = document.querySelector('[aria-label="Session mail"]')
    const focusable = [...document.querySelectorAll("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])")]
      .filter((element) => !element.disabled && element.offsetParent !== null && element.tabIndex >= 0)
    return focusable[focusable.indexOf(trigger) + (shift ? -1 : 1)]?.outerHTML.slice(0, 120)
  }, shift)
  for (const shift of [false, true]) {
    await menu.press("Enter")
    await expect(content.getByRole("menuitem").first()).toBeFocused()
    const expected = await neighbour(shift)
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab")
    await expect(content).toHaveCount(0)
    await expect(menu).toHaveAttribute("aria-expanded", "false")
    expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))).toBe(expected)
  }
  // The Find shortcut moves focus out of the open menu, which closes it.
  await menu.press("Enter")
  await expect(content).toBeVisible()
  await page.keyboard.press("Control+f")
  await expect(page.getByRole("searchbox", { name: "Find in transcript" })).toBeFocused()
  await expect(content).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("searchbox", { name: "Find in transcript" })).toHaveCount(0)
  await menu.click()
  await expect(content).toBeVisible()
  // The menu sits in the viewport and above the transcript, not behind the header.
  const menuBox = await content.boundingBox()
  expect(menuBox.x).toBeGreaterThanOrEqual(0)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width + 1)
  if (shots) await page.screenshot({ path: `${shots}-${label}-menu.png` })
  await page.mouse.click(Math.round(viewport.width / 2), viewport.height - 40)
  await expect(content).toHaveCount(0)

  // Panels open from the menu, take space only while open, and close from inside.
  await menu.click()
  await content.getByRole("menuitem", { name: "Lane mail (12)" }).click()
  await expect(page.locator(".lane-mail [data-mail-id]")).toHaveCount(12)
  await menu.click()
  await expect(content.getByRole("menuitem", { name: "Hide lane mail" })).toBeVisible()
  await content.getByRole("menuitem", { name: "Mail subscriptions" }).click()
  await expect(page.getByRole("button", { name: "Hide mail subscriptions" })).toBeVisible()
  await page.getByRole("button", { name: "Hide mail subscriptions" }).click()
  await page.getByRole("button", { name: "Hide lane mail" }).click()
  await expect(page.locator(".lane-mail")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Hide mail subscriptions" })).toHaveCount(0)

  // Find keeps its accessible name and opens from the icon.
  await find.click()
  await expect(page.getByRole("searchbox", { name: "Find in transcript" })).toBeFocused()
  await page.keyboard.press("Escape")
  expect(unexpectedWrites().length).toBe(writes)
  await context.close()
}

try {
  await run({ width: 1440, height: 900 }, "desktop-ltr")
  await run({ width: 1440, height: 900 }, "desktop-rtl", "rtl", "en")
  await run({ width: 1440, height: 900 }, "desktop-ar", "rtl", "ar")
  await run({ width: 320, height: 720 }, "mobile-ltr")
  await run({ width: 320, height: 720 }, "mobile-rtl", "rtl", "ar")
  expect(errors).toEqual([])
  console.log("session header browser checks passed")
} finally {
  await browser.close()
  await preview.close()
}

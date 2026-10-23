// Front desk chat folds beside a selection (orchestrator#83): explicit toggle, sticky preference,
// 36px rail with status dots, chat kept mounted (draft, scroll, selection unchanged), restore on
// Close, narrow bottom bar + sheet, and the selected decision reflows into two columns when wide.
// Disposable in-memory fixture only. Run from packages/es-app: node test/desk-chat-fold.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const artifacts = process.env.DESK_FOLD_ARTIFACTS
const preview = await startAttentionPreview()
preview.fixture.permissions = []
const browser = await chromium.launch({ channel: "chrome", headless: true })

const openDesk = async ({ width, height, rtl = false }) => {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 90_000 })
  // A cold Vite dependency optimization can delay the first render.
  await expect(page.locator(".desk-chat textarea")).toBeVisible({ timeout: 90_000 })
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  return { page, errors, context }
}
const shot = (page, name) => artifacts ? page.screenshot({ path: `${artifacts}/fold-${name}.png` }) : undefined

try {
  const { page, errors, context } = await openDesk({ width: 1440, height: 1000 })
  const decision = page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]')
  const composer = page.locator(".desk-chat textarea")
  // The folded chat leaves the accessibility tree, so it is found by its element, not its role.
  const chat = page.locator("section.desk-chat")
  const hide = page.getByRole("button", { name: "Hide chat" })
  const show = page.getByRole("button", { name: "Show chat" })
  const rail = page.locator(".desk-chat-rail")
  const chatScroll = () => page.evaluate(() => {
    const scrollers = [...document.querySelectorAll(".desk-chat *")].filter((el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))
    return scrollers.map((el) => el.scrollTop)
  })

  // No selection: the chat is the page and offers no fold.
  await expect(hide).toHaveCount(0)
  await composer.fill("draft kept across the fold")
  await decision.click()
  await expect(page.getByRole("region", { name: "Selected item" })).toBeVisible()
  await expect(hide).toBeVisible()
  const before = { scroll: await chatScroll(), width: (await chat.boundingBox()).width }
  await shot(page, "1440-expanded")

  // Fold: explicit, focus moves to the rail, the chat stays mounted and unchanged.
  await composer.focus()
  await hide.click()
  await expect(show).toBeFocused()
  await expect(rail).toBeVisible()
  expect(Math.round((await rail.boundingBox()).width)).toBe(36)
  await expect(chat).toBeHidden()
  expect(await chat.evaluate((el) => el.inert)).toBe(true)
  await expect(composer).toHaveValue("draft kept across the fold")
  await expect(rail.locator('[data-dot="draft"]')).toBeVisible()
  await expect(decision).toHaveAttribute("aria-pressed", "true")
  expect(await chat.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(Math.round(before.width))
  await shot(page, "1440-folded")

  // Wide pane: two columns, the answer beside the explanation and Send on screen. With a prepared
  // brief the inline-end column opens with its question above the options.
  const act = page.locator(".home-decision-act")
  const explain = page.locator(".home-decision-explain")
  const question = page.locator(".home-decision-question")
  const actBox = await act.boundingBox()
  const explainBox = await explain.boundingBox()
  const endTop = (await question.count()) ? (await question.boundingBox()).y : actBox.y
  expect(actBox.x, "answer column sits at inline-end").toBeGreaterThan(explainBox.x + explainBox.width - 1)
  expect(Math.abs(endTop - explainBox.y), "columns share a top").toBeLessThan(2)
  const send = page.getByRole("button", { name: /^Send/ }).first()
  const sendBox = await send.boundingBox()
  expect(sendBox.y + sendBox.height, "Send fits the window").toBeLessThanOrEqual(1000)

  // The preference is sticky: Close restores the chat, the next selection reopens folded.
  await page.getByRole("button", { name: "Close and return to chat" }).first().click()
  await expect(chat).toBeVisible()
  await expect(rail).toHaveCount(0)
  await expect(composer).toHaveValue("draft kept across the fold")
  await decision.click()
  await expect(rail).toBeVisible()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator(".desk-chat-rail")).toBeVisible({ timeout: 90_000 })

  // Expand from the rail: focus returns to the composer, scroll and draft unchanged.
  await page.getByRole("button", { name: "Show chat" }).focus()
  await page.getByRole("button", { name: "Show chat" }).click()
  await expect(page.locator(".desk-chat-rail")).toHaveCount(0)
  await expect(page.locator(".desk-chat textarea")).toBeFocused()
  await expect(page.locator(".desk-chat textarea")).toHaveValue("draft kept across the fold")
  await expect(page.getByRole("button", { name: "Hide chat" })).toBeVisible()
  expect(await chatScroll()).toEqual(before.scroll)
  expect(errors).toEqual([])
  await context.close()

  // Narrow: a bottom bar that opens the chat as a sheet; the selection stays.
  const narrow = await openDesk({ width: 390, height: 800 })
  await narrow.page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]').click()
  await narrow.page.getByRole("button", { name: "Hide chat" }).click()
  const bar = narrow.page.locator(".desk-chat-rail")
  await expect(bar).toBeVisible()
  const barBox = await bar.boundingBox()
  expect(Math.round(barBox.height)).toBe(44)
  expect(Math.round(barBox.y + barBox.height)).toBeLessThanOrEqual(800)
  await shot(narrow.page, "390-bar")
  await bar.click()
  const sheet = narrow.page.locator(".desk-chat-sheet")
  await expect(sheet).toBeVisible()
  const sheetBox = await sheet.boundingBox()
  expect(sheetBox.width).toBe(390)
  await expect(narrow.page.locator(".desk-chat-sheet textarea")).toBeVisible()
  await shot(narrow.page, "390-sheet")
  await narrow.page.getByRole("button", { name: "Close chat" }).click()
  await expect(bar).toBeVisible()
  await expect(narrow.page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]')).toHaveAttribute("aria-pressed", "true")
  expect(narrow.errors).toEqual([])
  await narrow.context.close()

  // RTL: the rail sits at the inline end, which is the left.
  const rtl = await openDesk({ width: 1440, height: 1000, rtl: true })
  await rtl.page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]').click()
  await rtl.page.getByRole("button", { name: "Hide chat" }).click()
  const rtlRail = await rtl.page.locator(".desk-chat-rail").boundingBox()
  const rtlQueue = await rtl.page.getByRole("complementary", { name: "Desk queue" }).boundingBox()
  expect(rtlRail.x).toBeLessThan(rtlQueue.x)
  await shot(rtl.page, "1440-rtl-folded")
  await rtl.context.close()
  console.log("desk-chat-fold: PASS")
} finally {
  await browser.close()
  await preview.close()
}

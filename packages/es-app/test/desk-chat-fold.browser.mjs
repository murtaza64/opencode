// The persistent Front desk companion closes without losing draft, scroll or selection.
// Its work-view preference survives navigation and reload; below 1200px it floats (docked overlay; a full-screen sheet when narrow), closed until opened.
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const artifacts = process.env.DESK_FOLD_ARTIFACTS
const preview = await startAttentionPreview()
preview.fixture.permissions = []
preview.fixture.messages = Array.from({ length: 30 }, (_, index) => ({
  info: { id: `msg_${String(index).padStart(4, "0")}`, sessionID: "ses_a", role: "user", agent: "build",
    model: { providerID: "fixture", modelID: "test" }, time: { created: index + 1 } },
  parts: [{ id: `part_${index}`, messageID: `msg_${String(index).padStart(4, "0")}`, sessionID: "ses_a", type: "text", text: `Desk history ${index}: ${"Context to read. ".repeat(15)}` }],
}))
const browser = await chromium.launch({ channel: "chrome", headless: true })
const openDesk = async ({ width, height, rtl = false }) => {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.addInitScript(value => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 90_000 })
  // A floating chat starts closed; wait for the app either way.
  await expect(page.locator(width >= 1200 ? ".desk-companion textarea" : ".desk-queue")).toBeVisible({ timeout: 90_000 })
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  return { page, errors, context }
}
const shot = (page, name) => artifacts ? page.screenshot({ path: `${artifacts}/fold-${name}.png` }) : undefined
const chatScroll = page => page.evaluate(() => [...document.querySelectorAll(".desk-companion-in *")]
  .filter(el => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)).map(el => el.scrollTop))

try {
  const { page, errors, context } = await openDesk({ width: 1440, height: 1000 })
  const decision = page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]')
  const composer = page.locator(".desk-companion textarea")
  const companion = page.locator(".desk-companion")
  const nav = page.locator('[data-nav="front-desk"]')
  await expect(nav).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(".desk-idle")).toContainText("Select a decision, document or surface.")
  await composer.fill("draft kept across the close")
  await decision.click()
  await expect(page.getByRole("region", { name: "Selected item" })).toBeVisible()
  await page.locator(".desk-companion .transcript").evaluate(el => { el.scrollTop = Math.max(1, el.scrollHeight / 2) })
  const before = { scroll: await chatScroll(page), width: (await companion.locator(".desk-companion-in").boundingBox()).width }
  expect(before.scroll.some(value => value > 0), "chat history is scrolled before closing").toBe(true)
  await shot(page, "1440-expanded")

  // Close from inside the chat: focus returns to nav; the mounted pane is inert and keeps its width inside.
  await composer.focus()
  await page.getByRole("button", { name: "Close Front desk chat" }).click()
  await expect(nav).toBeFocused()
  await expect(nav).toHaveAttribute("aria-pressed", "false")
  await expect(companion).toHaveClass(/closed/)
  await expect(companion).toHaveAttribute("aria-hidden", "true")
  expect(await companion.evaluate(el => el.inert)).toBe(true)
  await expect(composer).toHaveValue("draft kept across the close")
  await expect(decision).toHaveAttribute("aria-pressed", "true")
  expect(Math.round((await companion.locator(".desk-companion-in").boundingBox()).width)).toBe(Math.round(before.width))
  await shot(page, "1440-closed")

  // Wide evidence reflows beside the explanation while the companion is closed.
  const act = await page.locator(".home-decision-act").boundingBox()
  const explain = await page.locator(".home-decision-explain").boundingBox()
  const question = page.locator(".home-decision-question")
  const endTop = await question.count() ? (await question.boundingBox()).y : act.y
  expect(act.x, "answer column at inline-end").toBeGreaterThan(explain.x + explain.width - 1)
  expect(Math.abs(endTop - explain.y), "columns share a top").toBeLessThan(2)
  const send = await page.getByRole("button", { name: /^Send/ }).first().boundingBox()
  expect(send.y + send.height, "Send fits the window").toBeLessThanOrEqual(1000)

  await nav.click()
  await expect(composer).toBeVisible()
  expect(await chatScroll(page), "scroll survives closing and reopening the mounted companion").toEqual(before.scroll)
  await nav.click()
  await expect(companion).toHaveClass(/closed/)

  // Closing evidence does not reopen the chat. The preference persists on other work routes and reload.
  await page.locator('.desk-evidence-head button[aria-label="Close"]').click()
  await expect(page.locator(".desk-idle")).toBeVisible()
  await expect(companion).toHaveClass(/closed/)
  await decision.click()
  await expect(companion).toHaveClass(/closed/)
  await page.locator('a.nav-entry[href="/agents"]').click()
  await expect(companion).toHaveClass(/closed/)
  await page.locator('a.nav-entry[aria-label^="Decisions & inbox"]').click()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(companion).toHaveClass(/closed/)
  await expect(companion).toHaveAttribute("aria-hidden", "true")
  await nav.click()
  await expect(nav).toHaveAttribute("aria-pressed", "true")
  await expect(composer).toBeVisible()
  await composer.click()
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue("draft kept across the close")
  expect(errors).toEqual([])
  await context.close()

  // Below the docked width the chat floats: closed at first (never covering what you opened), opened from the nav.
  const medium = await openDesk({ width: 1100, height: 800 })
  const overlay = medium.page.locator(".desk-companion.overlay")
  await expect(overlay).toHaveClass(/closed/)
  await medium.page.locator('[data-nav="front-desk"]').click()
  await expect(overlay).toBeVisible()
  expect(await overlay.evaluate(el => getComputedStyle(el).position)).toBe("fixed")
  const overlayBox = await overlay.boundingBox()
  expect(Math.round(overlayBox.x + overlayBox.width), "docked at the inline end").toBe(1100)
  expect(Math.round(overlayBox.width)).toBe(380)
  await shot(medium.page, "1100-overlay")
  await medium.page.locator('[data-nav="front-desk"]').click()
  await expect(overlay).toHaveClass(/closed/)
  await medium.context.close()

  const narrow = await openDesk({ width: 390, height: 800 })
  const sheet = narrow.page.locator(".desk-companion.sheet")
  await expect(sheet).toHaveClass(/closed/)
  await narrow.page.locator('[data-nav="front-desk"]').click()
  await expect(sheet).toBeVisible()
  expect(await sheet.evaluate(el => getComputedStyle(el).position)).toBe("fixed")
  const sheetBox = await sheet.boundingBox()
  expect(Math.round(sheetBox.width)).toBe(390)
  expect(Math.round(sheetBox.x)).toBe(0)
  expect(Math.round(sheetBox.y + sheetBox.height)).toBe(800)
  await expect(sheet.locator("textarea")).toBeVisible()
  await shot(narrow.page, "390-sheet")
  await sheet.getByRole("button", { name: "Close Front desk chat" }).click()
  await expect(sheet).toHaveClass(/closed/)
  expect(await sheet.evaluate(el => el.inert)).toBe(true)
  await narrow.page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]').click()
  await expect(narrow.page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]')).toHaveAttribute("aria-pressed", "true")
  await narrow.page.locator('[data-nav="front-desk"]').click()
  await expect(sheet).toBeVisible()
  await shot(narrow.page, "390-closed")
  expect(narrow.errors).toEqual([])
  await narrow.context.close()

  const rtl = await openDesk({ width: 1440, height: 1000, rtl: true })
  const rtlPane = await rtl.page.locator(".desk-companion").boundingBox()
  const rtlSidebar = await rtl.page.locator("nav.nav-entries").boundingBox()
  expect(rtlPane.x + rtlPane.width, "RTL companion is at inline-end (left)").toBeLessThanOrEqual(rtlSidebar.x + 1)
  await rtl.page.locator('[data-nav="front-desk"]').click()
  await expect(rtl.page.locator(".desk-companion")).toHaveClass(/closed/)
  await shot(rtl.page, "1440-rtl-closed")
  expect(rtl.errors).toEqual([])
  await rtl.context.close()
  console.log("desk-chat-fold: PASS")
} finally {
  await browser.close()
  await preview.close()
}

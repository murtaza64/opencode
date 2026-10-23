// Front desk chat header: the embedded chat's title and tools stay inside the chat pane, and the
// window header (native macOS titlebar row or web top bar) keeps one row with every control
// visible and clickable. Normal, short, narrow and RTL windows; selection open and closed.
// Disposable in-memory fixture only. Run from packages/es-app: node test/desk-chat-header.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const ELECTRON_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })

// Opens the desk with its chat on an existing fixture session.
const openDesk = async ({ width, height, userAgent, rtl = false }) => {
  const context = await browser.newContext({ viewport: { width, height }, userAgent })
  await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 90_000 })
  // A cold Vite dependency optimization can delay the first render.
  await expect(page.locator(".desk-chat textarea")).toBeVisible({ timeout: 90_000 })
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  return { page, errors, close: () => context.close() }
}

const layout = (page) => page.evaluate(() => {
  const rect = (el) => { const box = el.getBoundingClientRect(); return { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom) } }
  const hittable = (el) => {
    const box = el.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  }
  const visible = (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0
  const chat = document.querySelector(".desk-chat")
  const chatHeaders = [...document.querySelectorAll(".topbar")].filter((el) => visible(el) && el.querySelector("[aria-label=Find]"))
  // Narrow windows stack the chat below the queue and selection; scroll to it as a reader would.
  chatHeaders[0]?.scrollIntoView({ block: "nearest" })
  const header = document.querySelector(".native-header")
  const headerControls = header ? [...header.querySelectorAll("button, select, a, input")].filter(visible) : []
  return {
    chat: rect(chat),
    chatHeaders: chatHeaders.map(rect),
    find: chatHeaders.map((el) => hittable(el.querySelector("[aria-label=Find]"))),
    header: header && rect(header),
    // Anything drawn below the window header's bottom edge spills over the page.
    spill: header ? [...header.querySelectorAll("*")].filter(visible).filter((el) => el.getBoundingClientRect().bottom > header.getBoundingClientRect().bottom + 1).map((el) => `${el.tagName.toLowerCase()}.${el.className}`) : [],
    blocked: headerControls.filter((el) => !hittable(el)).map((el) => el.getAttribute("aria-label") || el.textContent.trim() || el.tagName),
  }
})

const expectContained = async (name, page) => {
  const result = await layout(page)
  expect(result.chatHeaders, `${name}: one chat header`).toHaveLength(1)
  const [box] = result.chatHeaders
  expect(box.left, `${name}: chat header starts inside the chat pane`).toBeGreaterThanOrEqual(result.chat.left)
  expect(box.right, `${name}: chat header ends inside the chat pane`).toBeLessThanOrEqual(result.chat.right)
  expect(box.top, `${name}: chat header is below the pane top`).toBeGreaterThanOrEqual(result.chat.top)
  expect(result.find, `${name}: chat tools are clickable`).toEqual([true])
  expect(result.spill, `${name}: window header keeps one row`).toEqual([])
  expect(result.blocked, `${name}: window header controls are clickable`).toEqual([])
}

try {
  for (const [name, options] of [
    ["web", { width: 1440, height: 900 }],
    ["native", { width: 1440, height: 900, userAgent: ELECTRON_MAC }],
    ["native short", { width: 1280, height: 560, userAgent: ELECTRON_MAC }],
    ["native narrow", { width: 860, height: 700, userAgent: ELECTRON_MAC }],
    ["native RTL", { width: 1280, height: 700, userAgent: ELECTRON_MAC, rtl: true }],
  ]) {
    const desk = await openDesk(options)
    await expectContained(`${name}, nothing selected`, desk.page)
    await desk.page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]').click()
    await expect(desk.page.getByRole("region", { name: "Selected item" })).toBeVisible()
    await expectContained(`${name}, item selected`, desk.page)
    expect(desk.errors).toEqual([])
    await desk.close()
  }
  console.log("desk-chat-header: PASS")
} finally {
  await browser.close()
  await preview.close()
}

// Front desk fits its column: on short, native-header, narrow and RTL windows the last control of the
// queue, the selected item and the chat composer can be scrolled to and clicked.
// Disposable in-memory fixture only. Run from packages/es-app: node test/desk-fit.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const ELECTRON_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"
const preview = await startAttentionPreview()
preview.fixture.permissions = ["per_1", "per_2", "per_3", "per_4"].map((id) => ({ id, sessionID: "ses_b", permission: "bash", patterns: [`echo ${id}`], always: ["echo *"], metadata: { command: `echo ${id}`, description: `Synthetic ${id}` } }))
const browser = await chromium.launch({ channel: "chrome", headless: true })

// Opens the desk with its chat on an existing fixture session and one decision selected.
const openDesk = async ({ width, height, userAgent, rtl = false }) => {
  const context = await browser.newContext({ viewport: { width, height }, userAgent })
  await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 90_000 })
  // A cold Vite dependency optimization can delay the first render.
  // Below the docked width the chat floats over the view and starts closed; open it once the item is selected.
  await page.locator('.desk-item[data-desk-item="attention:fixture:decision_1"]').click({ timeout: 90_000 })
  if (await page.locator(".desk-companion.closed").count()) await page.locator('[data-nav="front-desk"]').click()
  await expect(page.locator(".desk-chat textarea")).toBeVisible()
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  return { page, errors, close: () => context.close() }
}

// Scrolls the control into view through its own scroll containers and hit-tests its centre.
const reachable = (locator) => locator.evaluate((el) => {
  el.scrollIntoView({ block: "end" })
  const box = el.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return { bottom: Math.round(box.bottom), viewport: innerHeight, hit: !!hit && (hit === el || el.contains(hit)) }
})
const expectFits = async (name, page) => {
  const desk = await page.locator(".desk").evaluate(el => ({ bottom: Math.round(el.getBoundingClientRect().bottom), viewport: innerHeight }))
  expect(desk.bottom, `${name}: desk ends inside the window`).toBeLessThanOrEqual(desk.viewport)
  for (const [part, locator] of [
    ["queue", page.locator(".desk-queue .desk-sources-all > summary")],
    ["selected item", page.locator(".desk-evidence :is(button, summary, a)").last()],
    ["composer", page.locator(".desk-companion textarea")],
    ["composer actions", page.locator(".desk-companion .prompt-box button").last()],
  ]) {
    if (part === "queue" || part === "selected item") {
      // A full-screen sheet covers the nav; it closes from its own header.
      if (await page.locator(".desk-companion.sheet:not(.closed)").count()) await page.getByRole("button", { name: "Close Front desk chat" }).click()
      else if (await page.locator(".desk-companion.overlay:not(.closed)").count()) await page.locator('[data-nav="front-desk"]').click()
    } else if (await page.locator(".desk-companion.closed").count()) await page.locator('[data-nav="front-desk"]').click()
    const result = await reachable(locator)
    expect(result, `${name}: last ${part} control is reachable`).toMatchObject({ hit: true })
    expect(result.bottom, `${name}: last ${part} control ends inside the window`).toBeLessThanOrEqual(result.viewport)
  }
  await page.locator(".desk-companion textarea").click()
  await expect(page.locator(".desk-companion textarea"), `${name}: composer takes a click`).toBeFocused()
}

try {
  const short = await openDesk({ width: 1280, height: 560 })
  await expectFits("short desktop", short.page)
  expect(short.errors).toEqual([])
  await short.close()

  // The native macOS header takes the top of the window; the desk must fit below it.
  const native = await openDesk({ width: 1280, height: 560, userAgent: ELECTRON_MAC })
  await expect(native.page.locator(".native-header")).toBeVisible()
  await expectFits("native header", native.page)
  await native.close()

  // The narrow layout stacks the app sidebar above the content and the desk columns in one scroller.
  const narrow = await openDesk({ width: 600, height: 700 })
  await expectFits("narrow", narrow.page)
  await narrow.close()

  const rtl = await openDesk({ width: 1280, height: 560, userAgent: ELECTRON_MAC, rtl: true })
  await expectFits("native header RTL", rtl.page)
  await rtl.close()
  console.log("desk-fit: PASS")
} finally {
  await browser.close()
  await preview.close()
}

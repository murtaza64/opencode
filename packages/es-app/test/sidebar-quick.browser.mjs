// Sidebar quick row (Murtaza 2026-11-05 22:28Z): no "Decisions & inbox" nav row; Agent map, Usage and
// Porter/Desk share one compact row at the top. Decision deep links still open the same reader; the row
// is keyboard reachable, has a stable selected state, and mirrors in RTL. Disposable fixture.
// Run from packages/es-app: node test/sidebar-quick.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const nav = page.getByRole("navigation", { name: "Main" })
const quick = nav.locator(".nav-quick")
const map = quick.getByRole("link", { name: "Agent map", exact: true })
const usage = quick.getByRole("link", { name: "Usage", exact: true })
const porter = quick.getByRole("button", { name: "Porter (Front desk)", exact: true })
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(quick).toBeVisible({ timeout: 120_000 })
  // The legacy entry is gone; the three quick items share one row with equal targets.
  await expect(nav.getByRole("link", { name: /Decisions & inbox/ })).toHaveCount(0)
  await expect(quick.locator(":scope > .nav-quick-item")).toHaveCount(3)
  const boxes = await Promise.all([map, usage, porter].map(async (item) => item.boundingBox()))
  assert(boxes.every((box) => box && box.height >= 40), `44px targets: ${JSON.stringify(boxes)}`)
  assert.equal(new Set(boxes.map((box) => Math.round(box.y))).size, 1, `one row: ${JSON.stringify(boxes)}`)
  assert(Math.max(...boxes.map((box) => box.width)) - Math.min(...boxes.map((box) => box.width)) <= 1, `equal widths: ${JSON.stringify(boxes)}`)
  await expect(map).toHaveAttribute("aria-current", "page")
  if (shots) await page.screenshot({ path: path.join(shots, "sidebar-top-1440.png"), clip: { x: 0, y: 0, width: 260, height: 220 } })
  // Keyboard: Tab moves across the row; Enter opens Usage and its selection is stable.
  await map.focus()
  await page.keyboard.press("Tab")
  await expect(usage).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(`${preview.origin}/usage`)
  await expect(usage).toHaveAttribute("aria-current", "page")
  await expect(map).not.toHaveAttribute("aria-current", "page")
  await map.click()
  await expect(page).toHaveURL(`${preview.origin}/agents`)
  // Porter toggles the desk chat. Open is a dot on its icon, never the selected fill; only the current
  // view (Map here) carries that fill.
  if ((await porter.getAttribute("aria-pressed")) === "false") await porter.click()
  await expect(porter).toHaveAttribute("aria-pressed", "true")
  await expect(porter.locator(".nav-quick-open")).toBeVisible()
  assert.notEqual(await map.evaluate((el) => getComputedStyle(el).backgroundColor), await porter.evaluate((el) => getComputedStyle(el).backgroundColor), "only the current view has the selected fill")
  await porter.click()
  await expect(porter).toHaveAttribute("aria-pressed", "false")
  await expect(porter.locator(".nav-quick-open")).toHaveCount(0)
  // RTL mirrors the same logical order.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const rtl = await Promise.all([map, usage, porter].map(async (item) => (await item.boundingBox()).x))
  assert(rtl[0] > rtl[1] && rtl[1] > rtl[2], `RTL order Map, Usage, Porter: ${JSON.stringify(rtl)}`)
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  // A decision deep link still opens the same reader even though its nav row is gone.
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("attention:fixture:decision_1")}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-attention-id="decision_1"]')).toBeVisible({ timeout: 60_000 })
  // 390: the same single row.
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded" })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.mouse.move(0, 300)
  await expect(quick).toBeVisible()
  const narrow = await Promise.all([map, usage, porter].map(async (item) => item.boundingBox()))
  assert.equal(new Set(narrow.map((box) => Math.round(box.y))).size, 1, `390 one row: ${JSON.stringify(narrow)}`)
  if (shots) await page.screenshot({ path: path.join(shots, "sidebar-top-390.png"), clip: { x: 0, y: 0, width: 390, height: 168 } })
  assert.deepEqual(errors, [])
  console.log("PASS sidebar quick row: no legacy Decisions entry, three in one row, keyboard/selection, Porter toggle, RTL, deep link, 390")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}

// Title-bar spend: one combined Today · WTD · MTD (UTC) across Work hosts. OpenRouter key billing (one key counted
// once across hosts) plus each host's Core ledger without its openrouter rows. Mini unreachable: the known amounts
// show as partial ("≥") and the tooltip names Mini; never $0. No per-source chips. LTR and RTL.
// Run from packages/es-app: node test/today-cost.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const tokens = { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
const DAY = 86_400_000
const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
// 2 per day on a duolingo gateway; 50 per day on openrouter (the same spend as the key billing, never added).
const rollup = () => ({
  estimate: true, basis: "", host: "local", observedAt: new Date().toISOString(), offsetMinutes: 0, coverage: { scope: "", backfilled: true },
  days: Array.from({ length: 31 }, (_, index) => ({ day: new Date(today - index * DAY).toISOString().slice(0, 10), complete: true, cost: 52, originOnly: true, originCost: 52, unpricedModels: 0,
    models: [{ provider: "duolingo-anthropic", model: "m", cost: 2, coverage: "priced", tokens }, { provider: "openrouter", model: "auto", cost: 50, coverage: "priced", tokens }] })),
  rateLimits: { source: "headers", providers: [] },
})
const ori = { schema: "es-openrouter-usage/1", state: "ok", key_id: "0123456789abcdef", credits_today_utc_usd: 0, external_byok_today_utc_usd: 100,
  credits_week_utc_usd: 0, external_byok_week_utc_usd: 300, credits_month_utc_usd: 0, external_byok_month_utc_usd: 900 }
let miniUp = false
const preview = await startAttentionPreview([{
  name: "today-cost-fixture",
  enforce: "pre",
  configureServer(server) {
    server.middlewares.use("/__es/host", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "laptop", label: "Laptop", profile: "work", remote: false, hosts: [], work: [
        { id: "laptop", label: "Laptop", origin: "http://127.0.0.1:1", profile: "work" }, { id: "mini", label: "Mini", origin: "http://127.0.0.1:2", profile: "work" }] }))
    })
    server.middlewares.use("/hosts/mini", (req, res) => {
      if (!miniUp) { res.writeHead(502); return res.end("{}") }
      if (!/^\/(es\/api\/usage\/openrouter|oc\/experimental\/usage\/daily)/.test(req.url)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { "content-type": "application/json" })
      if (req.url.startsWith("/es/api/usage/openrouter")) return res.end(JSON.stringify({ ...ori, observedAt: new Date(Date.now() - 30_000).toISOString() }))
      if (req.url.startsWith("/oc/experimental/usage/daily")) return res.end(JSON.stringify(rollup()))
      res.end("[]")
    })
    server.middlewares.use("/es/api/usage/openrouter", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ...ori, observedAt: new Date().toISOString() }))
    })
    server.middlewares.use("/oc/experimental/usage/daily", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(rollup()))
    })
  },
}])
const week = Math.round((today - (today - ((new Date(today).getUTCDay() + 6) % 7) * DAY)) / DAY) + 1
const month = new Date(today).getUTCDate()
const money = (value) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
page.setDefaultTimeout(90_000)
const errors = []
page.on("pageerror", (error) => { errors.push(error.message); console.log("PE", miniUp, error.stack?.split("\n").slice(0, 3).join(" / ")) })
try {
  const badge = page.locator(".today-cost-group").filter({ visible: true })
  const amounts = () => badge.locator(".today-cost-amount").allTextContents()
  // Mini unreachable: Laptop's billing (counted once) plus its ledger; partial, Mini named.
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(badge).toBeVisible({ timeout: 120_000 })
  await expect(badge.locator(".today-cost-label")).toHaveText(["Today", "WTD", "MTD"])
  await expect.poll(amounts).toEqual([`≥${money(102)}`, `≥${money(300 + 2 * week)}`, `≥${money(900 + 2 * month)}`])
  const title = await badge.getAttribute("title")
  assert.match(title, /Mini OpenRouter: HTTP 502/)
  assert.match(title, /Mini Core: HTTP 502/)
  await expect(page.locator(".ori-today-cost, .ori-budget")).toHaveCount(0)
  if (shots) await page.screenshot({ path: path.join(shots, "title-bar-partial-ltr.png"), clip: { x: 0, y: 0, width: 640, height: 120 } })

  // Mini back, same key: the key counts once; Mini's ledger adds its gateway rows; no longer partial.
  miniUp = true
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect.poll(amounts, { timeout: 60_000 }).toEqual([money(104), money(300 + 4 * week), money(900 + 4 * month)])
  assert.doesNotMatch(await badge.getAttribute("title"), /Partial/)
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const [group, sidebar] = await Promise.all([badge.boundingBox(), page.locator("nav.sidebar").boundingBox()])
  assert(group.x < sidebar.x + sidebar.width && group.x + group.width <= sidebar.x + sidebar.width + 1, "RTL: badge stays in the sidebar top row")
  await expect(badge.locator(".today-cost-amount").first()).toHaveAttribute("dir", "ltr")
  if (shots) await page.screenshot({ path: path.join(shots, "title-bar-rtl.png"), clip: { x: 640, y: 0, width: 640, height: 120 } })
  assert.deepEqual(errors, [])
  console.log("PASS today-cost: Today/WTD/MTD combined, Mini unreachable partial + named, one key once, Ori rows not double-counted, RTL")
} catch (error) {
  console.error(error)
  if (shots) await page.screenshot({ path: path.join(shots, "today-cost-failure.png") }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}

// COST-01: the title-bar "Today ~$N" badge (ux-feel contract, DESK-AND-SIDEBARS.md). Visible on the
// Front Desk, the Agent map and a session at 1440 and 760 px; colour bands at $40 / $200 / $600 (visual
// only); hidden, never $0, when this host's Core has no usage route; inline-end in RTL; no clipping at
// 125% zoom; one rollup read across ordinary navigation. Screenshots: SHOTS=<dir>.
// Run from packages/es-app: node test/today-cost.browser.mjs
import { createRequire } from "node:module"
import { mkdir } from "node:fs/promises"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })
const tokens = (input, output) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } })
let total = 142.4
let mode = "json"
// Newer Cores: nullable cost with per-model coverage.
let shape = "old"
// /__es/host answer (undefined: route missing, single host) and the Mini host's rollup.
let hostInfo
let mini = { mode: "fail" }
const originDay = (cost) => ({ day: new Date().toLocaleDateString("en-CA"), complete: true, cost, originOnly: true, originCost: cost, unpricedModels: cost === null ? 1 : 0, unpricedTokens: 0,
  models: [{ provider: "anthropic", model: "claude-opus", cost, coverage: cost === null ? "missing-rate" : "priced", tokens: tokens(1_000, 100) }] })
const reads = []
const rollup = () => ({
  estimate: true, basis: "Estimated; not provider billing.", host: "local", observedAt: new Date().toISOString(), offsetMinutes: -new Date().getTimezoneOffset(),
  coverage: { scope: "API-billed work agents on this host", liveSince: new Date(Date.now() - 3_600_000).toISOString(), backfilled: shape === "origin" },
  days: shape === "origin" ? [originDay(total)] : [shape === "old"
    ? { day: new Date().toLocaleDateString("en-CA"), cost: total, models: [{ provider: "anthropic", model: "claude-opus", cost: total, tokens: tokens(1_000_000, 50_000) }] }
    : { day: new Date().toLocaleDateString("en-CA"), complete: true, cost: total, unpricedModels: total === null ? 1 : 0, unpricedTokens: 0, models: [
      { provider: "gateway", model: "internal", cost: null, coverage: "missing-rate", tokens: tokens(10_000, 1_000) },
      ...(total === null ? [] : [{ provider: "anthropic", model: "claude-opus", cost: total, coverage: "priced", tokens: tokens(1_000_000, 50_000) }]),
    ] }],
  rateLimits: { source: "headers", providers: [] },
})
const preview = await startAttentionPreview([{
  name: "today-cost-fixture",
  // Before the app config's own /__es/host handler.
  enforce: "pre",
  configureServer(server) {
    server.middlewares.use("/__es/host", (_req, res) => {
      if (!hostInfo) { res.writeHead(404); return res.end() }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(hostInfo))
    })
    server.middlewares.use("/hosts/mini/oc/experimental/usage/daily", (_req, res) => {
      if (mini.mode === "fail") { res.writeHead(503); return res.end("{}") }
      const day = mini.mode === "origin" ? originDay(mini.cost) : { day: new Date().toLocaleDateString("en-CA"), cost: mini.cost, models: [{ provider: "a", model: "m", cost: mini.cost, tokens: tokens(1_000, 100) }] }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ...rollup(), days: [day], coverage: { scope: "Mini", backfilled: true } }))
    })
    server.middlewares.use("/oc/experimental/usage/daily", (req, res) => {
      // Count only the page under test: the preview's warm-up page also loads the app (and its badge).
      if (req.headers["x-under-test"]) reads.push(req.url)
      if (mode === "html") {
        res.writeHead(200, { "content-type": "text/html" })
        return res.end("<!doctype html><html><body>app</body></html>")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(rollup()))
    })
  },
}])
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.setExtraHTTPHeaders({ "x-under-test": "1" })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const badge = page.locator(".today-cost:visible")
const amount = badge.locator(".today-cost-amount")
const colour = (name) => page.evaluate((name) => { const probe = document.createElement("span"); probe.style.color = `var(--${name})`; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value }, name)
const inside = () => badge.evaluate((node) => { const rect = node.getBoundingClientRect(); const amountRect = node.lastElementChild.getBoundingClientRect(); return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth + 0.5 && node.scrollWidth <= node.clientWidth + 1 && amountRect.right <= window.innerWidth + 0.5 })
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(badge).toHaveCount(1, { timeout: 60_000 })
  await expect(amount).toHaveText("~$142")
  await expect(badge.locator(".today-cost-label")).toHaveText("Today")
  await expect(badge).toHaveAttribute("aria-label", "AI spend today: about 142 dollars, estimate")
  await expect(badge).toHaveAttribute("title", /^Estimated spend today \(local date\), API-billed work agents\n.*: \$142\.40 \(some usage unpriced or not yet counted\)|^Estimated spend today \(local date\), API-billed work agents\n.*\$142\.40/)
  await expect(badge).toHaveAttribute("data-band", "low")
  expect(await amount.evaluate((node) => getComputedStyle(node).color)).toBe(await colour("green"))
  if (shots) await page.screenshot({ path: `${shots}/desk-1440.png` })
  const views = [["agents", "/agents"], ["session", `/session/ses_a?directory=${encodeURIComponent(directory)}`]]
  for (const [name, path] of views) {
    await page.evaluate((path) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")) }, path)
    await expect(badge).toHaveCount(1)
    await expect(amount).toHaveText("~$142")
    expect(await inside(), `${name}: badge fully inside the viewport`).toBe(true)
    if (shots) await page.screenshot({ path: `${shots}/${name}-1440.png` })
  }
  await page.setViewportSize({ width: 760, height: 900 })
  for (const [name, path] of [["desk", "/"], ...views]) {
    await page.evaluate((path) => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")) }, path)
    await expect(badge).toHaveCount(1)
    expect(await inside(), `${name} at 760: badge fully inside the viewport`).toBe(true)
    if (shots) await page.screenshot({ path: `${shots}/${name}-760.png` })
  }
  // Ordinary navigation keeps one total: no read per page.
  expect(reads.filter((url) => url.includes("days=1"))).toHaveLength(1)
  console.log("PASS badge visible on desk, agent map and session at 1440 and 760; one read across navigation")

  await page.setViewportSize({ width: 1440, height: 900 })
  for (const [value, band, name, text] of [[40, "low", "green", "~$40"], [200, "mid", "text", "~$200"], [600, "high", "peach", "~$600"]]) {
    total = value
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(amount).toHaveText(text)
    await expect(badge).toHaveAttribute("data-band", band)
    expect(await amount.evaluate((node) => getComputedStyle(node).color), `$${value} is --${name}`).toBe(await colour(name))
    if (shots) await page.screenshot({ path: `${shots}/band-${value}.png`, clip: { x: 0, y: 0, width: 1440, height: 120 } })
  }
  console.log("PASS bands: $40 green, $200 text, $600 peach (never red)")

  await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
  const rtl = await badge.evaluate((node) => { const row = node.parentElement.getBoundingClientRect(); const rect = node.getBoundingClientRect(); return { start: rect.left - row.left, end: row.right - rect.right } })
  expect(rtl.start, "RTL: badge at the inline end (left)").toBeLessThan(rtl.end)
  if (shots) await page.screenshot({ path: `${shots}/rtl.png` })
  await page.evaluate(() => document.documentElement.setAttribute("dir", "ltr"))
  await page.evaluate(() => { document.documentElement.style.zoom = "1.25" })
  expect(await inside(), "125% zoom: no clipping").toBe(true)
  if (shots) await page.screenshot({ path: `${shots}/zoom-125.png` })
  await page.evaluate(() => { document.documentElement.style.zoom = "" })
  console.log("PASS RTL inline-end; 125% zoom unclipped")

  // Newer contract: a priced total with an unpriced model stays an estimate; a null total hides the badge.
  shape = "new"
  total = 90
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(amount).toHaveText("~$90")
  await expect(badge).toHaveAttribute("title", /\$90\.00/)
  total = null
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)
  await expect(page.locator(".today-cost")).toHaveCount(0)
  console.log("PASS newer rollup: unpriced model counted as partial; null total hidden, never $0")

  // Several WORK hosts: the badge sums origin-only costs; a host that cannot say is named and never blocks.
  hostInfo = { id: "local", label: "Laptop", remote: false, hosts: [], work: [{ id: "local", label: "Laptop", origin: preview.origin }, { id: "mini", label: "Mini", origin: "http://127.0.0.1:1" }] }
  shape = "origin"
  total = 40
  mini = { mode: "origin", cost: 25 }
  await page.reload({ waitUntil: "domcontentloaded" })
  // Rollups are always estimates, so the '~' stays; partial vs complete shows in the per-host tooltip.
  await expect(amount).toHaveText("~$65")
  await expect(badge).toHaveAttribute("aria-label", "AI spend today: about 65 dollars, estimate")
  await expect(badge).toHaveAttribute("data-partial", "false")
  await expect(badge).toHaveAttribute("title", /Laptop: \$40\.00/)
  await expect(badge).toHaveAttribute("title", /Mini: \$25\.00/)
  console.log("PASS two WORK hosts, origin-only: summed, complete")
  mini = { mode: "fail" }
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(amount).toHaveText("~$40")
  await expect(badge).toHaveAttribute("title", /Mini: unreachable/)
  await expect(badge).toHaveAttribute("data-partial", "true")
  console.log("PASS one WORK host unreachable: the other's total shows, partial, host named")
  mini = { mode: "raw", cost: 25 }
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(amount).toHaveText("~$40")
  await expect(badge).toHaveAttribute("title", /Mini: \$25\.00 \(may overlap another host.*not in total/)
  console.log("PASS older Core without origin-only cost: not summed (may overlap), partial")
  mini = { mode: "origin", cost: null }
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(amount).toHaveText("~$40")
  await expect(badge).toHaveAttribute("title", /Mini: unpriced/)
  console.log("PASS unpriced WORK host: partial, never $0")
  hostInfo = undefined
  shape = "old"

  mode = "html"
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)
  await expect(page.locator(".today-cost")).toHaveCount(0)
  // No zero total anywhere in the title row or sidebar top (session costs elsewhere are separate).
  await expect(page.locator(".native-header, .sidebar-top").getByText(/\$0\b/)).toHaveCount(0)
  console.log("PASS older Core: badge hidden, never $0")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

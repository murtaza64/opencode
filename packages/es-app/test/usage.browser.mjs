// COST-01 U1: Usage page over a fixture rollup. Today's estimated total for this host only, by model,
// last 7 days, rate-limit headers labelled as not quota, incomplete coverage, zero price shown as
// missing pricing (not free), and an old Core (HTML for the route) shown as unavailable.
// One rollup read on open; none while the page sits idle.
// Run from packages/es-app: node test/usage.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const today = new Date()
const day = (offset) => { const at = new Date(today); at.setDate(at.getDate() - offset); return at.toLocaleDateString("en-CA") }
const tokens = (input, output) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } })
const rollup = {
  estimate: true,
  basis: "Estimated from per-turn token counts and configured model prices; not provider billing.",
  host: "local",
  observedAt: new Date().toISOString(),
  offsetMinutes: -today.getTimezoneOffset(),
  coverage: { scope: "Turns recorded by this host's Core", liveSince: new Date(Date.now() - 3_600_000).toISOString(), backfilled: false },
  days: [
    { day: day(0), cost: 12.345, models: [
      { provider: "anthropic", model: "claude-opus", cost: 11.2, tokens: tokens(2_400_000, 90_000) },
      { provider: "openai", model: "gpt-5", cost: 1.145, tokens: tokens(300_000, 20_000) },
      { provider: "gateway", model: "internal-model", cost: 0, tokens: tokens(50_000, 4_000) },
    ] },
    ...Array.from({ length: 6 }, (_, index) => ({ day: day(index + 1), cost: index * 3.5, models: [] })),
  ],
  rateLimits: { source: "Latest response headers; not billing or subscription quota", providers: [
    { provider: "anthropic", observedAt: new Date().toISOString(), headers: {}, requests: { limit: 4000, remaining: 3990 }, tokens: { limit: 2_000_000, remaining: 1_500_000, reset: "2026-10-27T22:00:00Z" } },
  ] },
}
let mode = "json"
const reads = []
const preview = await startAttentionPreview([{
  name: "usage-fixture",
  configureServer(server) {
    server.middlewares.use("/oc/experimental/usage/daily", (req, res) => {
      // Count only the page under test: the preview's warm-up page also loads the app (and its badge).
      if (req.headers["x-under-test"]) reads.push(req.url)
      if (mode === "html") {
        res.writeHead(200, { "content-type": "text/html" })
        return res.end("<!doctype html><html><body>app</body></html>")
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(rollup))
    })
  },
}])
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
await context.setExtraHTTPHeaders({ "x-under-test": "1" })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
try {
  await page.goto(`${preview.url}/usage`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const total = page.locator("[data-usage-total]")
  await expect(total).toHaveText("$12.35")
  await expect(page.locator(".usage-today")).toContainText("ONLY · ESTIMATE")
  await expect(page.locator(".usage-today")).toContainText("+ unpriced usage")
  await expect(page.locator("[data-usage-incomplete]")).toContainText("Incomplete: counted since")
  await expect(page.locator(".usage-today")).toContainText("Other hosts are not included.")
  const rows = page.locator(".usage-table tbody tr")
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText("anthropic/claude-opus")
  await expect(rows.nth(0)).toContainText("$11.20")
  await expect(rows.nth(2)).toContainText("gateway/internal-model")
  await expect(rows.nth(2)).toContainText("pricing missing")
  await expect(rows.nth(2)).not.toContainText("$0.00")
  await expect(page.locator(".usage-days li")).toHaveCount(7)
  await expect(page.getByLabel("Rate limits")).toContainText("Not a plan or subscription quota.")
  await expect(page.getByLabel("Rate limits")).toContainText("3,990 of 4,000 requests left")
  // The page reads 7 days; the title-bar total reads today only.
  const pageReads = () => reads.filter((url) => url.includes("days=7"))
  await expect.poll(() => pageReads().length).toBe(1)
  expect(pageReads()[0]).toContain("days=7")
  expect(pageReads()[0]).toContain(`offsetMinutes=${-today.getTimezoneOffset()}`)
  // No polling while the page sits open.
  const before = reads.length
  await page.waitForTimeout(5000)
  expect(reads).toHaveLength(before)
  console.log("PASS usage: this-host estimate, by model, 7 days, missing pricing not free, incomplete coverage, rate limits not quota, one read")

  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => pageReads().length).toBe(2)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal overflow at 390px RTL").toBe(true)
  await page.evaluate(() => document.documentElement.setAttribute("dir", "ltr"))
  await page.setViewportSize({ width: 1280, height: 860 })
  console.log("PASS usage: Refresh reads once; 390px RTL has no horizontal overflow")

  mode = "html"
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator(".usage-page")).toContainText("Usage is not available on")
  await expect(total).toHaveCount(0)
  console.log("PASS usage: an older Core (HTML for the route) reads as unavailable, not $0")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

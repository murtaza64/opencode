// The global session index (/oc/experimental/session, ~250 KB-1 MB) is read once on open and then
// at most every 2 minutes in the background: dashboard refreshes, lineage refreshes and handoff
// edges whose successor is already indexed no longer re-read it. A successor missing from the index
// is sought once. Run from packages/es-app: node test/session-index-reads.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const fixture = preview.fixture
fixture.handoffs = [{ lane: "home-agents", predecessor: "ses_b", successor: "ses_a" }]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
await context.setExtraHTTPHeaders({ "x-under-test": "1" })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const reads = []
context.on("request", (request) => { if (new URL(request.url()).pathname === "/oc/experimental/session") reads.push(Date.now()) })
const page = await context.newPage()
try {
  // All projects: the dashboard's 60 s refresh used to re-read the index each time.
  await page.goto(`${preview.url}/agents?agents=all`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(page.locator(".map-node-box").first()).toBeVisible({ timeout: 120_000 })
  await expect.poll(() => reads.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
  const opened = reads.length
  await page.waitForTimeout(70_000)
  console.log(JSON.stringify({ open_reads: opened, idle_70s_reads: reads.length - opened }))
  expect(opened, "one index read on open").toBe(1)
  expect(reads.length - opened, "no background index read within 70 s").toBe(0)
  console.log("PASS session index: one read on open, none in 70 s idle with handoffs and dashboard refreshes")
} finally {
  await browser.close()
  await preview.close()
}

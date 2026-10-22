import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const report = { lane: "fixture-agent", owner: "ses_a", activity: "Reviewing the bounded attention adapter", activity_at: new Date().toISOString(), activity_session: "ses_a" }
preview.fixture.laneOwners = [report]
const original = preview.fixture.currentWork
let status = "busy"
let offline = false
preview.fixture.currentWork = (...args) => {
  if (offline) return { status: 503, body: { error: "fixture telemetry unavailable" } }
  const value = original(...args)
  value.turn.status = status
  return value
}
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const pinned = page.getByRole("region", { name: "Pinned agents", exact: true })
const brief = pinned.locator(".activity-brief").first()
try {
  await page.goto(`${preview.url}/?view=agents`)
  await expect(brief).toContainText("Reviewing the bounded attention adapter")
  await expect(brief).toHaveAttribute("data-source", "reported")
  expect(preview.ledger.workCalls.map(call => call.id)).toEqual(["ses_a"])
  expect(preview.fixture.calls.filter(call => call.path.endsWith("/todo"))).toEqual([])
  report.activity_at = new Date(Date.now() - 360_000).toISOString()
  preview.fixture.emitDashboard("state")
  await expect(brief).toHaveAttribute("data-source", "tool")
  await expect(brief).toContainText("read")
  await expect(brief).toContainText("age unknown")
  report.activity_at = new Date().toISOString()
  report.activity_session = "ses_former_owner"
  preview.fixture.emitDashboard("state")
  await expect(brief).toHaveAttribute("data-source", "tool")
  report.activity_session = "ses_a"
  preview.fixture.emitDashboard("state")
  await expect(brief).toHaveAttribute("data-source", "reported")
  status = "idle"
  await expect(brief).toHaveAttribute("data-source", "status", { timeout: 12_000 })
  await expect(brief).toContainText("Idle")
  await expect(brief).not.toContainText(report.activity)
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.setViewportSize({ width: 760, height: 1000 })
  expect(await pinned.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  offline = true
  await pinned.getByText("Turn telemetry", { exact: true }).click()
  await expect(pinned).toContainText("refresh failed", { timeout: 40_000 })
  await expect(brief).toContainText("Activity unknown")
  expect(preview.fixture.calls.filter(call => call.generate === "true")).toEqual([])
  expect(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS pinned activity brief: shared report TTL/owner checks, safe tool fallback, idle/offline override, bounded telemetry reuse, no TODO fetch/generation/runtime writes, RTL")
} finally { await browser.close(); await preview.close() }

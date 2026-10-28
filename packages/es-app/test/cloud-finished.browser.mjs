// Finished cloud agents (NAV-09, dotfiles#240): always listed in the ordinary agent list (no Cloud header, no
// Include finished switch), with the same status dot as session rows and the Wingman glyph beside it; they
// survive a reload and match a search; pinning one keeps the local draft. Disposable fixture; no writes.
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const synced = new Date().toISOString()
// Activity is when the lane last changed; wingman-synced is only when it was last fetched (always "now" here).
preview.ledger.cloudLanes = [
  { ...preview.ledger.cloudLanes[0], "wingman-synced": synced, "wingman-activity": "2026-10-20T10:00:00Z", lane: "ended-review", owner: "wingman:ended-review-task", status: "parked", "wingman-status": "ended", activity: "Completed fixture awaiting PR review", "wingman-prs": "https://github.com/example/repo/pull/1103" },
  { ...preview.ledger.cloudLanes[0], "wingman-synced": synced, lane: "failed-build", owner: "wingman:failed-build-task", "wingman-status": "failed" },
  { ...preview.ledger.cloudLanes[0], "wingman-synced": synced, "wingman-activity": new Date(Date.now() - 60_000).toISOString(), lane: "busy-review", owner: "wingman:busy-task", "wingman-status": "processing" },
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const sidebar = page.locator(".sidebar")
const list = sidebar.locator("[role=tabpanel]")
const row = lane => list.locator(`.cloud-nav-entry`, { hasText: lane })
try {
  await page.goto(`${preview.url}/agents`)
  await sidebar.locator(".pinned-section").getByRole("link", { name: /Composer fixture/ }).click()
  const draft = page.getByRole("textbox", { name: "Message", exact: true })
  await draft.fill("Keep my local draft while finding completed cloud work")
  // Finished agents are listed without any switch or header.
  await expect(row("ended-review")).toHaveCount(1)
  await expect(sidebar.getByRole("checkbox", { name: "Include finished" })).toHaveCount(0)
  await expect(sidebar.locator(".cloud-source")).toHaveCount(0)
  // Order is by turn boundary only. Wingman reports none yet, so its rows are undated: an old agent fetched just
  // now (fresh wingman-synced, older wingman-activity) never shows under Today, and the order is stable by identity.
  await expect(list.locator(".nav-day", { hasText: "Today" })).toHaveCount(0)
  const order = await list.locator(".cloud-nav-entry .nav-title").allTextContents()
  await page.reload()
  await expect(list.locator(".cloud-nav-entry .nav-title")).toHaveText(order)
  // Same dots as session rows, runtime glyph separate.
  await expect(row("busy-review").locator(".dot")).toHaveClass("dot busy")
  await expect(row("failed-build").locator(".dot")).toHaveClass("dot failed")
  await expect(row("ended-review").locator(".dot")).toHaveClass("dot idle")
  await expect(row("ended-review").locator(".host-glyph")).toHaveCount(1)
  // Survives reload and matches a search.
  await page.reload()
  await expect(row("ended-review")).toHaveCount(1)
  await sidebar.locator(".search-input").fill("ended")
  await expect(list.locator(".cloud-nav-entry", { hasText: "ended-review" })).toHaveCount(1)
  await sidebar.locator(".search-input").press("Escape")
  // Pin and open it; the local draft is kept.
  await row("ended-review").getByRole("button", { name: "Pin cloud agent ended-review", exact: true }).click()
  await page.locator('.pinned-section [data-cloud-owner="wingman:ended-review-task"] a').click()
  const details = page.getByRole("region", { name: "Cloud agent details", exact: true })
  await expect(details).toContainText("Completed fixture awaiting PR review")
  await sidebar.locator(".pinned-section").getByRole("link", { name: /Composer fixture/ }).click()
  await expect(draft).toHaveValue("Keep my local draft while finding completed cloud work")
  // RTL keeps the row readable (no overflow).
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.setViewportSize({ width: 760, height: 1000 })
  await expect(sidebar.locator(".pinned-section .cloud-nav")).toBeVisible()
  await page.locator(".sidebar .pinned-section").getByRole("button", { name: /^Unpin cloud agent/ }).click()
  await expect(row("ended-review")).toHaveCount(1)
  if (preview.fixture.calls.some(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))) throw new Error("unexpected writes")
  console.log("PASS finished cloud agents: always listed, undated by turn boundary (never Today from a fetch), stable across reload, no header or switch, matching dots + Wingman glyph, reload + search, pin keeps draft, RTL narrow; no writes")
} finally { await browser.close(); await preview.close() }

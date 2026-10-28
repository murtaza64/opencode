// Unified nav slice 1 (dotfiles#240): Needs you band on top (decisions and permissions from the desk queue),
// Pinned below, then Surfaces | Agents | Decisions | PRs tabs with independent filters. A decision filtered out
// of the Decisions tab still shows in the band. Tabs are keyboard operable (arrows, mirrored in RTL) and the
// chosen tab is remembered. Disposable fixture; no writes. Run from packages/es-app: node test/nav-tabs.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
// Start from the default tab once; later loads keep what was chosen.
await context.addInitScript(() => { try { if (!sessionStorage.getItem("nav-tabs-test")) { localStorage.removeItem("es-app:nav-tab"); sessionStorage.setItem("nav-tabs-test", "1") } } catch {} })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
const sidebar = page.locator("nav.sidebar")
const band = sidebar.getByRole("region", { name: "Needs you" })
const tab = name => sidebar.getByRole("tab", { name: new RegExp(`^${name}`) })
const panel = sidebar.locator("[role=tabpanel]")
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(band).toBeVisible({ timeout: 120_000 })
  // Order: band above Pinned above the tabs.
  const tops = await page.evaluate(() => ["section.needs-you-band", "section.pinned-section", ".nav-tabs"].map(s => document.querySelector(`nav.sidebar ${s}`)?.getBoundingClientRect().top ?? -1))
  assert(tops[0] >= 0 && tops[0] < tops[1] && tops[1] < tops[2], `band, Pinned, tabs in order: ${tops}`)
  await expect(band.locator(".nav-decision", { hasText: "Choose the bounded implementation scope" })).toHaveCount(1)
  await expect(band.locator('.nav-decision[data-kind="permission"]').first()).toBeVisible()
  // On another page no band row reads as selected.
  await expect(band.locator(".nav-item.active")).toHaveCount(0)
  // Agents is the default tab and holds the session list with its own search.
  await expect(tab("Agents")).toHaveAttribute("aria-selected", "true")
  await expect(panel.locator(".search-input[placeholder='search sessions…']")).toBeVisible()
  if (shots) await page.screenshot({ path: path.join(shots, "agents.png"), clip: { x: 0, y: 0, width: 320, height: 900 } })
  // Decisions tab: its own filter; filtering it out never removes the item from the band.
  await tab("Decisions").click()
  await expect(panel.locator(".nav-decision", { hasText: "Choose the bounded implementation scope" })).toHaveCount(1)
  await panel.getByRole("searchbox", { name: "Filter Decisions" }).fill("zzz-nothing")
  await expect(panel.locator(".nav-decision")).toHaveCount(0)
  await expect(panel).toContainText("no matches")
  await expect(band.locator(".nav-decision", { hasText: "Choose the bounded implementation scope" })).toHaveCount(1)
  // Independent filters: Agents search is untouched; Decisions keeps its filter after a round trip.
  await tab("Agents").click()
  await expect(panel.locator(".search-input")).toHaveValue("")
  await tab("Decisions").click()
  await expect(panel.getByRole("searchbox", { name: "Filter Decisions" })).toHaveValue("zzz-nothing")
  // Opening a decision goes to the Front desk with it selected.
  await panel.getByRole("searchbox", { name: "Filter Decisions" }).fill("")
  await panel.locator(".nav-decision", { hasText: "Choose the bounded implementation scope" }).click()
  await expect(page).toHaveURL(/\?item=attention%3Afixture%3Adecision_1/)
  // Only the open item is marked current.
  await expect(sidebar.locator(".nav-decision.active")).toHaveCount(2)
  await expect(sidebar.locator('.nav-item[aria-current="page"][data-nav-item="attention:fixture:decision_1"]')).toHaveCount(2)
  // Surfaces and PRs tabs render their own panels (read-only).
  await tab("Surfaces").click()
  await expect(panel.getByRole("searchbox", { name: "Filter Surfaces" })).toBeVisible()
  await tab("PRs").click()
  await expect(panel.getByRole("searchbox", { name: "Filter PRs" })).toBeVisible()
  if (shots) await page.screenshot({ path: path.join(shots, "prs.png"), clip: { x: 0, y: 0, width: 320, height: 900 } })
  // Keyboard: arrows move between tabs; RTL mirrors them.
  await tab("PRs").focus()
  await page.keyboard.press("ArrowLeft")
  await expect(tab("Decisions")).toHaveAttribute("aria-selected", "true")
  await expect(tab("Decisions")).toBeFocused()
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await tab("Decisions").focus()
  await page.keyboard.press("ArrowLeft")
  await expect(tab("PRs")).toHaveAttribute("aria-selected", "true")
  if (shots) await page.screenshot({ path: path.join(shots, "rtl.png"), clip: { x: 960, y: 0, width: 320, height: 900 } })
  // The chosen tab is remembered across a reload.
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.reload()
  await expect(tab("PRs")).toHaveAttribute("aria-selected", "true", { timeout: 60_000 })
  assert.deepEqual(errors, [])
  assert.deepEqual(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session"), [])
  console.log("PASS nav tabs: band > Pinned > tabs, band unfiltered by tab, independent filters, decision opens on the desk, Surfaces/PRs panels, keyboard + RTL, remembered tab; no writes")
} finally {
  await browser.close()
  await preview.close()
}

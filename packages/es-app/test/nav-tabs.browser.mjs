// Unified sidebar (dotfiles#240, Loupe BUILD): one list. Needs you opens it; Recent follows. Four chips
// (All · Agents · Surfaces · Decisions) narrow the list; PRs have no chip, row or panel. Chips are
// keyboard operable (arrows, mirrored in RTL) and the chosen chip is remembered.
// Disposable fixture; no writes. Run from packages/es-app: node test/nav-tabs.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
// Start from the default chip once; later loads keep what was chosen.
await context.addInitScript(() => { try { if (!sessionStorage.getItem("nav-tabs-test")) { localStorage.removeItem("es-app:nav-tab"); sessionStorage.setItem("nav-tabs-test", "1") } } catch {} })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const sidebar = page.locator("nav.sidebar")
const band = sidebar.getByRole("region", { name: "Needs you" })
const chip = (name) => sidebar.getByRole("tab", { name: new RegExp(`^${name}`) })
const panel = sidebar.locator("[role=tabpanel]")
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(band).toBeVisible({ timeout: 120_000 })
  // Order: chips, then Needs you, then the one list panel.
  const tops = await page.evaluate(() => [".nav-tabs", "section.needs-you-band", "[role=tabpanel]"].map(selector => document.querySelector(`nav.sidebar ${selector}`)?.getBoundingClientRect().top ?? -1))
  assert(tops[0] >= 0 && tops[0] < tops[1] && tops[1] < tops[2], `chips, Needs you, panel in order: ${tops}`)
  await expect(sidebar.locator(".nav-tab-label")).toHaveText(["All", "Agents", "Surfaces", "Decisions"])
  await expect(chip("All")).toHaveAttribute("aria-selected", "true")
  await expect(sidebar.getByRole("tab", { name: /PRs/ })).toHaveCount(0)
  await expect(sidebar.locator(".nav-prs")).toHaveCount(0)
  await expect(band.locator(".nav-decision", { hasText: "Choose the bounded implementation scope" })).toHaveCount(1)
  await expect(band.locator('.nav-decision[data-kind="permission"]').first()).toBeVisible()
  // All is the blended Recent list: agents, Surfaces and closed decisions share it.
  await expect(panel.locator(".recent-list")).toBeVisible()
  await expect(panel.locator(".recent-list .session-entry").first()).toBeVisible()
  if (shots) await page.screenshot({ path: path.join(shots, "all.png"), clip: { x: 0, y: 0, width: 320, height: 900 } })
  // Decisions chip narrows to the decision views; its filter never changes Needs you.
  await chip("Decisions").click()
  await expect(panel.locator(".nav-decision", { hasText: "Choose the bounded implementation scope" })).toHaveCount(1)
  await panel.getByRole("searchbox", { name: "Filter Decisions" }).fill("zzz-nothing")
  await expect(panel.locator(".nav-decision")).toHaveCount(0)
  await expect(panel).toContainText("no matches")
  await expect(band.locator(".nav-decision", { hasText: "Choose the bounded implementation scope" })).toHaveCount(1)
  // Independent filters: Agents search is untouched; Decisions keeps its filter after a round trip.
  await chip("Agents").click()
  await expect(sidebar.locator(".agent-toolbar .search-input")).toHaveValue("")
  await chip("Decisions").click()
  await expect(panel.getByRole("searchbox", { name: "Filter Decisions" })).toHaveValue("zzz-nothing")
  // Opening a decision from Needs you goes to the Front desk with it selected.
  await panel.getByRole("searchbox", { name: "Filter Decisions" }).fill("")
  await band.locator(".nav-decision", { hasText: "Choose the bounded implementation scope" }).click()
  await expect(page).toHaveURL(/\?item=attention%3Afixture%3Adecision_1/)
  await expect(sidebar.locator('.nav-item[aria-current="page"][data-nav-item="attention:fixture:decision_1"]')).toHaveCount(2)
  // Surfaces chip shows its own read-only list.
  await chip("Surfaces").click()
  await expect(panel.getByRole("searchbox", { name: "Filter Surfaces" })).toBeVisible()
  if (shots) await page.screenshot({ path: path.join(shots, "surfaces.png"), clip: { x: 0, y: 0, width: 320, height: 900 } })
  // Keyboard: arrows move between chips; RTL mirrors them.
  await chip("Surfaces").focus()
  await page.keyboard.press("ArrowRight")
  await expect(chip("Decisions")).toHaveAttribute("aria-selected", "true")
  await expect(chip("Decisions")).toBeFocused()
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await chip("Decisions").focus()
  await page.keyboard.press("ArrowRight")
  await expect(chip("Surfaces")).toHaveAttribute("aria-selected", "true")
  await expect(chip("Surfaces")).toBeFocused()
  if (shots) await page.screenshot({ path: path.join(shots, "rtl.png"), clip: { x: 640, y: 0, width: 320, height: 900 } })
  // The chosen chip is remembered across a reload.
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.reload()
  await expect(chip("Surfaces")).toHaveAttribute("aria-selected", "true", { timeout: 60_000 })
  assert.deepEqual(errors, [])
  assert.deepEqual(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session"), [])
  console.log("PASS nav-tabs")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}

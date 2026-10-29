// Agents tab controls (NAV-16/17): the top-bar project select is gone; the Agents tab carries a project scope chip,
// an Active filter and an explicit sort. The Agents tab count is agents working now in this scope (Local and the
// Mini, same session ID on both), "N+" when a host cannot be read. Tabs select immediately, keep their width as
// counts change, move by arrow keys (mirrored in RTL) and do not animate under reduced motion.
// Run from packages/es-app: node test/agents-filters.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { selectScope } from "./scope.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const miniRoot = "/Users/mini/fixture"
let miniDown = false
const miniSessions = [
  { id: "ses_a", title: "Mini copy of a", directory: miniRoot, time: { created: 1, updated: Date.now() } },
  { id: "ses_m", title: "Alpha mini idle", directory: miniRoot, time: { created: 1, updated: Date.now() - 1000 } },
]
await page.addInitScript(() => localStorage.setItem("es-app:nav-tab", "agents"))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url },
  { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:65001", default: true },
] } }))
await page.route("**/hosts/mini/**", (route) => {
  if (miniDown) return route.abort("connectionrefused")
  const path = new URL(route.request().url()).pathname
  if (path === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: miniSessions })
  if (path === "/hosts/mini/oc/session/status") return route.fulfill({ json: { ses_a: { type: "busy" } } })
  if (path === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false } })
  if (path === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniRoot}/.editspace` }], default: "fixture" } })
  return route.fulfill({ json: [] })
})
const sidebar = page.locator("nav.sidebar")
const agentsTab = sidebar.getByRole("tab", { name: /^Agents/ })
const list = sidebar.locator("[role=tabpanel] > .session-entry .nav-title")
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(sidebar.getByRole("link", { name: /^Mini copy of a, on Mac Mini$/ })).toBeVisible({ timeout: 120_000 })
  // No top-bar select; scope lives in the Agents tab.
  await expect(page.locator("select.es-switcher")).toHaveCount(0)
  const scope = sidebar.locator(".scope-menu summary")
  await expect(scope).toBeVisible()

  // Count = working now in scope, from the same live bucket the rows show: it equals the busy dots in Agents
  // and Pinned (at least Local's busy ses_a), never the total.
  const busy = () => page.evaluate(() => document.querySelectorAll("nav.sidebar .pinned-section .dot.busy, nav.sidebar [role=tabpanel] > .session-entry .dot.busy").length)
  await expect.poll(busy).toBeGreaterThan(0)
  await expect(agentsTab.locator(".nav-tab-count")).toHaveText(String(await busy()))
  expect(Number(await agentsTab.locator(".nav-tab-count").textContent())).toBeLessThan(await sidebar.locator("[role=tabpanel] > .session-entry").count() + await sidebar.locator(".pinned-section .session-entry").count())
  const width = (await agentsTab.boundingBox()).width

  // Active filter keeps only the working rows; sort by name orders the full list alphabetically.
  await sidebar.getByRole("button", { name: "Active" }).click()
  await expect(list.filter({ hasText: "Other session" })).toHaveCount(0)
  await expect(list.filter({ hasText: "Alpha mini idle" })).toHaveCount(0)
  await expect.poll(() => list.count()).toBeGreaterThan(0)
  expect(await sidebar.locator("[role=tabpanel] > .session-entry .dot:not(.busy)").count()).toBe(0)
  await sidebar.getByRole("button", { name: "Active" }).click()
  await sidebar.getByRole("button", { name: /^Sort: activity/ }).click()
  await expect(sidebar.getByRole("button", { name: /^Sort: name/ })).toBeVisible()
  const titles = await list.allTextContents()
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)))
  // Reload keeps the sort.
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(sidebar.getByRole("button", { name: /^Sort: name/ })).toBeVisible({ timeout: 120_000 })
  await sidebar.getByRole("button", { name: /^Sort: name/ }).click()

  // Scope chip: choose a project, then All; Escape closes and returns focus.
  await selectScope(page, "fixture")
  await expect(scope).toHaveAttribute("aria-label", "Project: fixture")
  await selectScope(page, "__all__")
  await expect(scope).toHaveAttribute("aria-label", "Project: all projects")
  await scope.click()
  await page.keyboard.press("Escape")
  await expect(scope).toBeFocused()
  await expect(sidebar.locator(".scope-menu")).not.toHaveAttribute("open", "")

  // The Mini stops answering: the count says "N+" and the tab keeps its width.
  miniDown = true
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(sidebar.locator(".host-status", { hasText: "Mac Mini" })).toContainText("unreachable", { timeout: 120_000 })
  await expect(agentsTab.locator(".nav-tab-count")).toHaveText(/\+$/)
  expect(Math.abs((await agentsTab.boundingBox()).width - width)).toBeLessThan(1)

  // Immediate selection: rapid switching ends on the last tab clicked, with its panel shown at once.
  for (const name of ["Surfaces", "Decisions", "PRs", "Agents", "Decisions"]) await sidebar.getByRole("tab", { name: new RegExp(`^${name}`) }).click()
  await expect(sidebar.getByRole("tab", { name: /^Decisions/ })).toHaveAttribute("aria-selected", "true")
  await expect(sidebar.locator("[role=tabpanel]")).toHaveAttribute("aria-labelledby", "nav-tab-decisions")
  // Keyboard, RTL: ArrowLeft moves forward in reading order.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await sidebar.getByRole("tab", { name: /^Decisions/ }).focus()
  await page.keyboard.press("ArrowLeft")
  await expect(sidebar.getByRole("tab", { name: /^PRs/ })).toHaveAttribute("aria-selected", "true")
  await expect(sidebar.getByRole("tab", { name: /^PRs/ })).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await agentsTab.click()
  await page.screenshot({ path: "/tmp/agents-filters-rtl-390.png" })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })

  // Reduced motion: no transition on the tab underline.
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await agentsTab.evaluate((tab) => getComputedStyle(tab, "::after").transitionDuration)).toBe("0s")
  expect(errors).toEqual([])
  console.log("agents-filters: PASS")
} finally {
  await browser.close()
  await preview.close()
}

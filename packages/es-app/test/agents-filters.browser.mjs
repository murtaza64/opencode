// Agents tab controls (NAV-16/17, Laptop2677): one row of New, Search and one Filter control; its popover holds the
// project scope, hosts, show (working now) and sort, applies at once, and its count names what differs from the defaults. The Agents tab count is agents working now in this scope (Local and the
// Mini, same session ID on both), "N+" when a host cannot be read. Tabs select immediately, keep their width as
// counts change, move by arrow keys (mirrored in RTL) and do not animate under reduced motion.
// Run from packages/es-app: node test/agents-filters.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { chooseFilter, openFilter, selectScope } from "./scope.mjs"

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
  { id: "ses_a", title: "Mini copy of a", directory: miniRoot, time: { created: Date.now() - 5000, updated: Date.now() } },
  { id: "ses_m", title: "Alpha mini idle", directory: miniRoot, time: { created: Date.now() - 1000, updated: Date.now() - 1000 } },
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
const list = sidebar.locator("[role=tabpanel] .session-entry .nav-title")
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(sidebar.getByRole("link", { name: /^Mini copy of a, on Mac Mini$/ })).toBeVisible({ timeout: 120_000 })
  // No top-bar select; scope lives in the Agents tab.
  await expect(page.locator("select.es-switcher")).toHaveCount(0)
  const filter = sidebar.locator(".sidebar-filter > summary")
  await expect(filter).toBeVisible()
  // One toolbar row: New session (NAV-17, the only one in the expanded sidebar), Search, Filter; no other control rows.
  const toolbar = sidebar.locator(".agent-toolbar")
  await expect(toolbar.getByRole("link", { name: "New session", exact: true })).toHaveAttribute("href", "/new")
  await expect(toolbar.locator(".search-input")).toBeVisible()
  await expect(sidebar.locator(".agent-filters, .work-hosts, .search-box, .scope-menu")).toHaveCount(0)
  expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(40)
  // A closed popover leaves no dialog laid out (desktop guards count dialogs by their boxes); open, exactly one.
  const laidOutDialogs = () => page.evaluate(() => [...document.querySelectorAll("[role=dialog], [role=alertdialog]")].filter((element) => element.getClientRects().length).length)
  expect(await laidOutDialogs()).toBe(0)
  await filter.click()
  await expect(sidebar.locator(".sidebar-filter-panel")).toBeVisible()
  expect(await laidOutDialogs()).toBe(1)
  await page.keyboard.press("Escape")
  await expect(sidebar.locator(".sidebar-filter-panel")).toHaveCount(0)
  expect(await laidOutDialogs()).toBe(0)
  // Defaults: no count; the default project is not a filter.
  await expect(filter.locator(".sidebar-filter-count")).toHaveCount(0)
  await expect(filter).toHaveAttribute("aria-label", "Filter and sort")
  await expect(sidebar.getByRole("link", { name: "New session", exact: true })).toHaveCount(1)
  await expect(sidebar.locator(".sidebar-actions")).toHaveCount(0)

  // Chips carry no counts; the list itself shows the working state.
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("nav.sidebar .pinned-section .dot.busy, nav.sidebar [role=tabpanel] .session-entry .dot.busy").length)).toBeGreaterThan(0)
  await expect(sidebar.locator(".nav-tab-count")).toHaveCount(0)
  const width = (await agentsTab.boundingBox()).width

  // Active filter keeps only the working rows; sort by name orders the full list alphabetically.
  await chooseFilter(page, "Show", "Working now")
  await expect(list.filter({ hasText: "Other session" })).toHaveCount(0)
  await expect(list.filter({ hasText: "Alpha mini idle" })).toHaveCount(0)
  await expect.poll(() => list.count()).toBeGreaterThan(0)
  expect(await sidebar.locator("[role=tabpanel] .session-entry .dot:not(.busy)").count()).toBe(0)
  // A filter that hides rows says so under the list, with Clear; the control counts it and names it.
  await expect(filter.locator(".sidebar-filter-count")).toHaveText("1")
  await expect(filter).toHaveAttribute("aria-label", "Filter and sort: working now")
  const hiddenLine = sidebar.locator(".filtered-out")
  await expect(hiddenLine).toContainText(/^\d+ hidden by filters/)
  await hiddenLine.getByRole("button", { name: "Clear" }).click()
  await expect(hiddenLine).toHaveCount(0)
  await expect(list.filter({ hasText: "Other session" })).toHaveCount(1)
  await chooseFilter(page, "Sort", "Name")
  await expect(filter).toHaveAttribute("aria-label", "Filter and sort: by name")
  const titles = await list.allTextContents()
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)))
  // Reload keeps the sort.
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(filter).toHaveAttribute("aria-label", "Filter and sort: by name", { timeout: 120_000 })
  // Created: newest first by the session's own creation time (the Mini's two, then Local's older ones).
  await chooseFilter(page, "Sort", "Created")
  await expect.poll(async () => (await list.allTextContents()).slice(0, 2)).toEqual(["Alpha mini idle", "Mini copy of a"])
  // Keyboard: Enter opens the popover; choices apply at once; Clear restores the defaults; Escape closes it and returns
  // focus to the control.
  await filter.focus()
  await page.keyboard.press("Enter")
  const popover = sidebar.locator(".sidebar-filter-panel")
  await expect(popover).toBeVisible()
  await expect(popover.getByRole("radio", { name: "Created" })).toBeChecked()
  await popover.getByRole("radio", { name: "Activity" }).focus()
  await page.keyboard.press("Space")
  await expect(filter.locator(".sidebar-filter-count")).toHaveCount(0)
  await popover.getByRole("radio", { name: "Name" }).check()
  await popover.getByRole("radio", { name: "Working now" }).check()
  await expect(filter.locator(".sidebar-filter-count")).toHaveText("2")
  await popover.getByRole("button", { name: "Clear" }).click()
  await expect(filter.locator(".sidebar-filter-count")).toHaveCount(0)
  await expect(popover.getByRole("button", { name: "Clear" })).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(filter).toBeFocused()
  await expect(sidebar.locator(".sidebar-filter")).not.toHaveAttribute("open", "")
  // Project scope: another project counts; All projects hides nothing and does not.
  await selectScope(page, "fixture")
  await selectScope(page, "__all__")
  await expect(filter.locator(".sidebar-filter-count")).toHaveCount(0)

  // The Mini stops answering; the chips keep their width.
  miniDown = true
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(sidebar.locator(".host-status", { hasText: "Mac Mini" })).toContainText("unreachable", { timeout: 120_000 })
  expect(Math.abs((await agentsTab.boundingBox()).width - width)).toBeLessThan(1)

  // Immediate selection: rapid switching ends on the last tab clicked, with its panel shown at once.
  for (const name of ["Surfaces", "Decisions", "Agents", "Decisions"]) await sidebar.getByRole("tab", { name: new RegExp(`^${name}`) }).click()
  await expect(sidebar.getByRole("tab", { name: /^Decisions/ })).toHaveAttribute("aria-selected", "true")
  await expect(sidebar.locator("[role=tabpanel]")).toHaveAttribute("aria-labelledby", "nav-tab-decisions")
  // Keyboard, RTL: ArrowLeft moves forward in reading order.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await sidebar.getByRole("tab", { name: /^Decisions/ }).focus()
  await page.keyboard.press("ArrowLeft")
  await expect(sidebar.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true")
  await expect(sidebar.getByRole("tab", { name: /^All/ })).toBeFocused()
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

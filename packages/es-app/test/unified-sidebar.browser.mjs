// Unified sidebar (Loupe BUILD, approved ~21:13Z): one list. Needs you (decision, permission, fresh
// deliverable) opens it; Recent blends agents, Surfaces and closed decisions. Chips narrow by kind,
// compact rows are the default with an expanded toggle, kind shapes lead each row, PRs are absent,
// order holds under the pointer and on refetch, and hover/focus previews have no side effects.
// Disposable fixture; no writes. Run from packages/es-app: node test/unified-sidebar.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const now = Date.now()
const board = (id, title, updated, extra = {}) => ({ id, title, summary: null, kind: "path", owner: "Loupe", lane: "fixture/loupe", editspace: "fixture",
  updated_at: updated, revision: 2, health: { state: "ok" }, purpose: "board", ...extra })
const deliverable = (id, title, updated, extra = {}) => board(id, title, updated, { purpose: "deliverable", seen: false, ...extra })
preview.fixture.surfaces = [
  deliverable("deck", "DevXAI Seattle deck", now - 60_000, { revision: 3, whats_new: "r3: removed two slides; notes recorded" }),
  board("eks", "EKS migration dashboard", now - 3_600_000),
  board("ops", "Ops report", now - 7_200_000),
]
// One closed decision so Recent has an answered row beside agents and Surfaces.
preview.ledger.records.push({ ...preview.ledger.records[0], id: "answered_1", status: "answered", title: "Glasses detail level",
  answer: { id: "a1", text: "", choice_id: "small", answered_at: now - 10_800_000 }, updated_at: now - 10_800_000 })

const miniRoot = "/Users/mini/fixture"
const miniSurfaces = [board("relay", "Relay board", now - 20_000, { owner: "Mini Loupe" })]
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  if (sessionStorage.getItem("unified-sidebar-init")) return
  sessionStorage.setItem("unified-sidebar-init", "1")
  localStorage.removeItem("es-app:nav-tab"); localStorage.removeItem("es-app:sidebar-density")
  localStorage.removeItem("es-app:sidebar-order"); localStorage.removeItem("es-app:sidebar-opened:1")
  localStorage.setItem("es-app-all-projects", "false")
})
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await context.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Mini", profile: "work", remote: false, hosts: [], work: [
  { id: "local", label: "Mini", origin: preview.fixture.url, profile: "work" },
  { id: "laptop", label: "Laptop", origin: "http://127.0.0.1:65001", profile: "work" },
] } }))
await context.route("**/hosts/laptop/**", (route) => {
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/laptop/es/api/surfaces") return route.fulfill({ json: { surfaces: miniSurfaces } })
  if (url.pathname === "/hosts/laptop/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false, limit: 200,
    inputs: { schema: "needs-you-inputs/1", boot: "b", rev: 1, requests: [], failures: [], ignores: [], deliverables: [],
      sources: { requests: { checked_at: 1, ok: true }, failures: { checked_at: 1, ok: true }, ignores: { checked_at: 1, ok: true }, deliverables: { checked_at: 1, ok: true } } } } })
  if (url.pathname === "/hosts/laptop/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniRoot}/.editspace` }], default: "fixture" } })
  if (url.pathname === "/hosts/laptop/oc/experimental/session") return route.fulfill({ json: [{ id: "ses_mini", title: "Mini worker", directory: miniRoot, time: { created: 1, updated: now } }] })
  if (url.pathname === "/hosts/laptop/oc/session/status") return route.fulfill({ json: { ses_mini: { type: "idle" } } })
  return route.fulfill({ json: [] })
})
const page = await context.newPage()
page.setDefaultTimeout(90_000)
const errors = []
const writes = []
page.on("pageerror", (error) => errors.push(error.message))
page.on("request", (request) => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && /attention|deliverables\/seen/.test(request.url()) && !/\/attention\/session$/.test(request.url())) writes.push(request.url()) })
const sidebar = page.locator("nav.sidebar")
const band = sidebar.getByRole("region", { name: "Needs you" })
const panel = sidebar.locator("[role=tabpanel]")
const recent = panel.locator(".recent-list")
const chips = sidebar.getByRole("tablist", { name: "Browse" })
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(sidebar).toBeVisible({ timeout: 120_000 })
  // One list: Needs you first, then Recent. Four chips, All selected, and no PR row, chip or count.
  await expect(band.getByText("Choose the bounded implementation scope")).toBeVisible({ timeout: 120_000 })
  await expect(chips.locator(".nav-tab-label")).toHaveText(["All", "Agents", "Surfaces", "Decisions"])
  await expect(chips.getByRole("tab", { name: /^All/ })).toHaveAttribute("aria-selected", "true")
  await expect(sidebar.getByRole("tab", { name: /PRs/ })).toHaveCount(0)
  await expect(sidebar.locator(".nav-prs, .pr-list")).toHaveCount(0)
  await expect(sidebar.getByText(/\bPRs\b/)).toHaveCount(0)
  // Needs you: the open decision, the pending permission and the fresh deliverable, with one count.
  await expect(band.locator(".nav-item[data-nav-item^='attention:']")).toHaveCount(1)
  await expect(band.locator(".nav-item[data-kind=permission]")).toHaveCount(1)
  await expect(band.locator(".nav-item[data-nav-item^='surface:']")).toHaveCount(1)
  await expect(band.locator(".nav-heading-count")).toHaveText("3")
  const order = await page.evaluate(() => [".needs-you-band", ".recent-list"].map((selector) => document.querySelector(`nav.sidebar ${selector}`)?.getBoundingClientRect().top ?? -1))
  assert(order[0] >= 0 && order[0] < order[1], `Needs you above Recent: ${order}`)
  // Recent: agents, Surfaces and the answered decision, blended. Agents lead with a round avatar shape.
  await expect(recent.locator(".session-entry").first()).toBeVisible()
  await expect(recent.locator(".nav-surface").first()).toBeVisible()
  await expect(recent.locator(".nav-history-row").first()).toBeVisible()
  await expect(recent.locator(".session-entry[data-avatar]").first()).toBeVisible()
  await expect(recent.locator(".nav-surface .surface-glyph").first()).toBeVisible()
  // Decision diamond and permission shield are shapes, not only colour.
  const diamond = await band.locator(".nav-decision[data-kind=decision] .nav-kind").first().evaluate((element) => getComputedStyle(element, "::before").transform)
  assert.notEqual(diamond, "none", "decision glyph draws a diamond")
  const shield = await band.locator(".nav-decision[data-kind=permission] .nav-kind").first().evaluate((element) => getComputedStyle(element, "::before").clipPath)
  assert.match(shield, /polygon/, "permission glyph draws a shield")

  if (shots) await page.screenshot({ path: path.join(shots, "compact-1440.png") })
  // Compact is the default (one line); the toggle beside search expands and is remembered.
  const root = sidebar.locator(".unified-sidebar")
  await expect(root).toHaveAttribute("data-density", "compact")
  const density = sidebar.locator(".density-toggle")
  await expect(density).toHaveAttribute("aria-pressed", "false")
  assert.equal(await recent.locator(".nav-surface").first().locator(".session-project").evaluate((element) => getComputedStyle(element).display), "none")
  await density.click()
  await expect(root).toHaveAttribute("data-density", "expanded")
  await expect(density).toHaveAttribute("aria-pressed", "true")
  assert.equal(await page.evaluate(() => localStorage.getItem("es-app:sidebar-density")), "expanded")
  if (shots) await page.screenshot({ path: path.join(shots, "expanded-1440.png") })
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(root).toHaveAttribute("data-density", "expanded", { timeout: 120_000 })
  await density.click()
  await expect(root).toHaveAttribute("data-density", "compact")

  // Hover preview: title, publisher and host, what's new, and explicitly no side effects.
  const surfaceRow = recent.locator(".nav-surface", { hasText: "DevXAI" })
  await surfaceRow.hover()
  const card = sidebar.locator(".sidebar-preview")
  await expect(card).toBeVisible()
  await expect(card.locator(".sidebar-preview-title")).toContainText("DevXAI")
  await expect(card).toContainText("published")
  await expect(card).toContainText("Mini")
  await expect(card).toContainText("removed two slides")
  await expect(card).toContainText("nothing marked seen")
  if (shots) await page.screenshot({ path: path.join(shots, "hover-1440.png") })
  await page.waitForTimeout(400)
  assert.deepEqual(writes, [], `preview wrote nothing: ${JSON.stringify(writes)}`)

  // No reorder under the pointer on a refetch; new rows wait behind "N new ↑".
  const before = await recent.locator(".nav-title").allTextContents()
  const hovered = await surfaceRow.evaluate((element) => element.closest(".recent-row")?.getAttribute("data-nav-key"))
  preview.fixture.surfaces = [
    ...preview.fixture.surfaces.map((surface) => surface.id === "ops" ? { ...surface, updated_at: now + 1000 } : surface),
    board("newboard", "Brand new board", now + 2000),
  ]
  preview.fixture.emit("fixture.changed", {})
  // Surfaces poll every 15 s; wait for the refetch this test is about.
  await page.waitForTimeout(16_000)
  const during = await recent.locator(".nav-title").allTextContents()
  assert.deepEqual(during, before, "refetch did not reorder the list under the pointer")
  assert.equal(await recent.locator(`.recent-row[data-nav-key="${hovered}"] .nav-title`).count(), 1)
  await page.mouse.move(600, 400)
  await expect(sidebar.locator(".new-items")).toContainText("1 new")
  await sidebar.locator(".new-items").click()
  await expect(recent.getByText("Brand new board")).toBeVisible()
  await expect(sidebar.locator(".new-items")).toHaveCount(0)

  // Keyboard: arrows move focus through the list and focus shows the preview; Enter opens the row.
  const links = recent.locator("a.nav-item")
  await links.first().focus()
  await expect(card).toBeVisible()
  const firstKey = await links.first().getAttribute("data-nav-item")
  await page.keyboard.press("ArrowDown")
  const nextKey = await page.evaluate(() => document.activeElement?.getAttribute?.("data-nav-item"))
  assert.notEqual(nextKey, firstKey, "ArrowDown moved focus")
  await page.keyboard.press("ArrowUp")
  await links.first().focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/surface%3A|%3Fitem=|item=/, { timeout: 30_000 })

  // RTL: the preview opens on the inline-start side and the chips still read in order.
  await page.goBack({ waitUntil: "domcontentloaded" })
  await expect(sidebar).toBeVisible({ timeout: 120_000 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const rtlRow = recent.locator(".nav-surface", { hasText: "DevXAI" })
  await rtlRow.hover()
  await expect(card).toBeVisible()
  assert.ok(await card.evaluate((element) => !!element.style.right), "RTL preview anchors on the right")
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.mouse.move(700, 500)
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await expect(card).toHaveCount(0)

  // 390: the drawer keeps one list and its chips. The app's narrow layout makes the rail a short top
  // strip; the frame shows the same rail at drawer height so the list itself is reviewable.
  await page.mouse.move(0, 0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addStyleTag({ content: "nav.sidebar { max-block-size: none !important; block-size: 844px !important; }" })
  await expect(sidebar).toBeVisible()
  await expect(chips.getByRole("tab")).toHaveCount(4)
  const box = await sidebar.boundingBox()
  assert(box.width <= 390, `sidebar fits 390: ${box.width}`)
  if (shots) await sidebar.screenshot({ path: path.join(shots, "compact-390.png") })

  assert.deepEqual(errors, [])
  console.log("PASS unified-sidebar")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}

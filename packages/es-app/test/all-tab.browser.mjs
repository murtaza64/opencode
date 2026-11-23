// All tab (Recent, Blended): every session shows (a session created after the list settled takes its sorted
// place, not the end), Agents-style day headings, one leading icon slot and one trailing time column for every
// row kind, and the decision hover/focus card (options offered, the chosen one, free-text answers). LTR and RTL.
// Disposable fixture; no writes. Run from packages/es-app: node test/all-tab.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const now = Date.now()
const H = 3_600_000
const board = (id, title, updated) => ({ id, title, summary: null, kind: "path", owner: "Loupe", lane: "fixture/loupe", editspace: "fixture",
  updated_at: updated, revision: 2, health: { state: "ok" }, purpose: "board" })
preview.fixture.surfaces = [board("eks", "EKS migration dashboard with a long title that must truncate", now - 2 * H), board("old", "Ops report", now - 30 * H)]
const agent = (id, title, at) => ({ id, title, directory, projectID: "fixture", slug: id, version: "1", agent: "build",
  time: { created: at, updated: at, turn: { started: at, ended: at } } })
preview.fixture.workspaceSessions.push(
  agent("ses_porter", "Porter", now - 13 * H),
  agent("ses_greeting", "Greeting with a very long session title that has to truncate before the time", now - 3 * H),
  agent("ses_old", "Last week's agent", now - 4 * 24 * H),
)
const base = preview.ledger.records[0]
preview.ledger.records.push(
  { ...base, id: "answered_choice", status: "answered", title: "Publish the Glasses tab into Edit", options: [{ id: "publish", label: "Publish now" }, { id: "wait", label: "Wait for review" }],
    recommendation: "publish", answer: { id: "a1", text: "", choice_id: "publish", answered_at: now - 15 * H }, updated_at: now - 15 * H },
  { ...base, id: "answered_text", status: "answered", title: "Install the MCP latency fix", options: [{ id: "install", label: "Install" }, { id: "skip", label: "Skip" }],
    answer: { id: "a2", text: "Install on Laptop only; Mini is off", choice_id: null, answered_at: now - 2 * H }, updated_at: now - 2 * H },
)

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.addInitScript(() => {
  if (sessionStorage.getItem("all-tab-init")) return
  sessionStorage.setItem("all-tab-init", "1")
  for (const key of ["es-app:nav-tab", "es-app:sidebar-density", "es-app:sidebar-order", "es-app:sidebar-opened:1"]) localStorage.removeItem(key)
  localStorage.setItem("es-app-all-projects", "false")
})
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
page.setDefaultTimeout(90_000)
const errors = []
const writes = []
page.on("pageerror", (error) => errors.push(error.message))
page.on("request", (request) => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && /attention|deliverables\/seen/.test(request.url()) && !/\/attention\/session$/.test(request.url())) writes.push(request.url()) })
const sidebar = page.locator("nav.sidebar")
const recent = sidebar.locator("[role=tabpanel] .recent-list:not(.active-list)")
const card = sidebar.locator(".sidebar-preview")

/** Every Recent row's leading icon, title and time, as inline-start / inline-end offsets from the list. */
const geometry = () => recent.evaluate((list) => {
  const rtl = getComputedStyle(list).direction === "rtl"
  const edge = list.getBoundingClientRect()
  const start = (box) => rtl ? edge.right - box.right : box.left - edge.left
  const end = (box) => rtl ? box.left - edge.left : edge.right - box.right
  return [...list.querySelectorAll(":scope > .session-entry, :scope > .recent-row, :scope > .cloud-nav-entry")].filter(row => row.getClientRects().length).map((row) => {
    const icon = row.querySelector(".session-avatar, .nav-kind, .surface-glyph")
    const title = row.querySelector(".nav-title")
    const time = row.querySelector(".row-trailing time")
    return { title: title?.textContent ?? "", icon: icon && [start(icon.getBoundingClientRect()), icon.getBoundingClientRect().width],
      text: title && start(title.getBoundingClientRect()), time: time && end(time.getBoundingClientRect()), truncated: title ? title.scrollWidth > title.clientWidth : false }
  })
})
const aligned = (rows, label) => {
  const spread = (values) => Math.max(...values) - Math.min(...values)
  const icons = rows.filter(row => row.icon)
  const times = rows.filter(row => row.time !== null)
  assert(icons.length >= 5 && spread(icons.map(row => row.icon[0] + row.icon[1] / 2)) <= 1, `${label}: one leading icon slot (centred) ${JSON.stringify(rows)}`)
  assert(spread(rows.filter(row => row.text !== null).map(row => row.text)) <= 1, `${label}: titles start at one x ${JSON.stringify(rows)}`)
  assert(times.length >= 5 && spread(times.map(row => row.time)) <= 1, `${label}: one trailing time column ${JSON.stringify(rows)}`)
  assert(rows.find(row => row.title.startsWith("Greeting"))?.truncated, `${label}: the long title truncates, not the time`)
}

try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(recent.getByText("Porter", { exact: true })).toBeVisible({ timeout: 120_000 })
  // Day headings as in Agents, in order.
  const headings = await recent.locator(".nav-day").allTextContents()
  assert.deepEqual(headings.filter((value, index) => headings.indexOf(value) === index), headings, `each day heading once: ${headings}`)
  assert.deepEqual(headings.slice(0, 2), ["Today", "Yesterday"])
  assert(headings.includes("This week"), `This week heading: ${headings}`)
  // Rows sit under their day: Porter (13h ago) is not under Yesterday unless it was yesterday locally.
  aligned(await geometry(), "LTR")
  if (shots) await sidebar.screenshot({ path: path.join(shots, "all-ltr.png") })

  // A session that appears after the list settled shows at once in its sorted place, under Today.
  await page.waitForTimeout(9_000)
  const fresh = agent("ses_fresh", "Freshly spawned lane", Date.now())
  preview.fixture.workspaceSessions.push(fresh)
  for (const [response, stream] of preview.fixture.eventStreams)
    if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type: "session.created", properties: { sessionID: fresh.id, info: fresh } } })}\n\n`)
  preview.fixture.emitDashboard("state")
  const row = recent.locator(".session-entry", { hasText: "Freshly spawned lane" })
  await expect(row).toBeVisible({ timeout: 30_000 }).catch(async (error) => {
    await sidebar.getByRole("tab", { name: /^Agents/ }).click()
    console.log("AGENTS has fresh:", await sidebar.getByText("Freshly spawned lane").count(), "| ALL titles:", await page.evaluate(() => 0))
    throw error
  })
  const order = await recent.locator(":scope > .nav-day, :scope > .session-entry .nav-title, :scope > .recent-row .nav-title").allTextContents()
  assert(order.indexOf("Freshly spawned lane") < order.indexOf("Yesterday"), `new session sorted into Today: ${order}`)
  await expect(sidebar.getByRole("tab", { name: /^Agents/ })).toBeVisible()

  // Decision card: an answered choice, a free-text answer, and a pending decision (focus shows the same card).
  await recent.locator(".recent-row", { hasText: "Publish the Glasses tab" }).hover()
  await expect(card.locator("li[data-chosen]")).toHaveText(/Publish now/)
  await expect(card.locator("li")).toHaveCount(2)
  await expect(card).toContainText("Chosen")
  if (shots) await page.screenshot({ path: path.join(shots, "decision-chosen-ltr.png"), clip: { x: 0, y: 0, width: 640, height: 900 } })
  await recent.locator(".recent-row", { hasText: "Install the MCP latency fix" }).hover()
  await expect(card.locator("li[data-chosen]")).toHaveCount(0)
  await expect(card).toContainText("Install on Laptop only; Mini is off")
  if (shots) await page.screenshot({ path: path.join(shots, "decision-text-ltr.png"), clip: { x: 0, y: 0, width: 640, height: 900 } })
  await page.mouse.move(900, 600)
  await sidebar.locator(".needs-you-band .nav-decision[data-kind=decision]").first().focus()
  await expect(card).toContainText("none chosen yet")
  await expect(card.locator("li")).toHaveText([/Small scope.*recommended/, /Defer/])
  if (shots) await page.screenshot({ path: path.join(shots, "decision-pending-focus.png"), clip: { x: 0, y: 0, width: 640, height: 900 } })
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())

  // RTL: mirrored, same alignment; the card opens on the inline-start side.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  aligned(await geometry(), "RTL")
  await recent.locator(".recent-row", { hasText: "Publish the Glasses tab" }).hover()
  await expect(card.locator("li[data-chosen]")).toHaveText(/Publish now/)
  assert.ok(await card.evaluate((element) => !!element.style.right), "RTL card anchors on the right")
  if (shots) await page.screenshot({ path: path.join(shots, "all-rtl.png") })
  await page.waitForTimeout(300)
  assert.deepEqual(writes, [], `no writes: ${JSON.stringify(writes)}`)
  assert.deepEqual(errors, [])
  console.log("PASS all-tab")
} catch (error) {
  console.error(error)
  if (shots) await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}

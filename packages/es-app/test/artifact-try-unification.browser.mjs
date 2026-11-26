// One item per artifact (DD artifact-try-decision-unification-20261103): a decision whose `artifact.surface` names a
// Surface and that Surface's Try are one row in Needs you and the Decisions tab; it opens the Surface reader with the
// decision's own answer controls inline. Without an explicit reference both rows stay. States: several decisions on
// one Surface, a decision about an older revision, an answered decision riding on a still-fresh Try, another host's
// pair keeping its host. Desktop, then 390px RTL. Disposable fixture. Run from packages/es-app: node test/artifact-try-unification.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const now = Date.now()
const options = [{ id: "develop", label: "Develop" }, { id: "park", label: "Park" }]
const record = (id, title, artifact, extra = {}) => ({ id, editspace: "fixture", revision: 1, status: "open", kind: "decision", title, context: "Develop, revise or park?", options,
  producer_session: "ses_a", origin_session: "ses_a", gate_key: `${id}:v1`, source_ref: { session_id: "ses_a", directory }, decision: null,
  delivery_state: "not-requested", created_at: now - 60_000, updated_at: now - 60_000, snoozed_until: null, artifact, ...extra })
const surface = (id, title, revision, extra = {}) => ({ id, title, summary: null, kind: "path", owner: "ux-feel", lane: "ux-feel", editspace: "fixture",
  updated_at: now - 1000, created_at: now - 1000, revision, purpose: "deliverable", seen: false, health: { state: "ok", checked_at: now, last_ok_at: now }, ...extra })
preview.ledger.operator = true
preview.fixture.permissions = []
preview.ledger.cloudLanes = []
preview.ledger.records = [
  record("pair_1", "Board r7: develop or park?", { title: "Board", surface: "board", revision: 7 }),
  record("pair_2", "Board r7: ship the legend too?", { title: "Board", surface: "board", revision: 7 }),
  record("old_1", "Chart: develop or park?", { title: "Chart", surface: "chart", revision: 5 }),
  record("done_1", "Gallery: develop or park?", { title: "Gallery", surface: "gallery", revision: 2 }, { status: "answered", answer: { choice_id: "develop", text: "", answered_at: now - 30_000 }, updated_at: now - 30_000 }),
  record("plain_1", "Pick a retention window", null),
  record("named_1", "Notes", null, { title: "Notes" }),
]
preview.fixture.surfaces = [surface("board", "Board", 7), surface("chart", "Chart", 7), surface("gallery", "Gallery", 2), surface("notes", "Notes", 1)]
const mini = "http://127.0.0.1:65031"
const miniRecord = record("33333333-3333-4333-8333-333333333333", "Mini map: develop or park?", { title: "Map", surface: "map", revision: 2 })
const miniSurface = surface("map", "Map", 2)
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const seen = []
await context.route("**/__es/surface/*", route => route.fulfill({ json: { src: "about:blank" } }))
await context.route("**/es/api/frontdesk/deliverables/seen", route => {
  const body = JSON.parse(route.request().postData())
  seen.push(body)
  preview.fixture.surfaces = preview.fixture.surfaces.map(item => item.id === body.id ? { ...item, seen: body.seen } : item)
  return route.fulfill({ json: { ok: true } })
})
await context.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: mini }] } }))
await context.route("**/hosts/mini/**", route => {
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: [] })
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (url.pathname === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [miniRecord], projects: [], partial: false, limit: 200,
    inputs: { schema: "needs-you-inputs/1", boot: "b", rev: 1, requests: [], failures: [], ignores: [], deliverables: [], sources: { requests: { checked_at: 1, ok: true }, failures: { checked_at: 1, ok: true }, ignores: { checked_at: 1, ok: true }, deliverables: { checked_at: 1, ok: true } } } } })
  if (url.pathname === `/hosts/mini/es/api/attention/${miniRecord.id}`) return route.fulfill({ json: { record: miniRecord, events: [] } })
  if (url.pathname === "/hosts/mini/es/api/surfaces") return route.fulfill({ json: { surfaces: [miniSurface] } })
  if (url.pathname === "/hosts/mini/__es/surface/map") return route.fulfill({ json: { src: "about:blank" } })
  return route.fulfill({ status: 403, body: "not exposed" })
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
const sidebar = page.locator("nav.sidebar")
const band = sidebar.getByRole("region", { name: "Needs you" })
const commands = () => preview.ledger.calls.filter(call => call.method === "POST" && call.path.endsWith("/commands"))
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const board = band.locator('[data-kind="try-decision"][data-nav-item="surface:board"]')
  await expect(board).toBeVisible({ timeout: 120_000 })
  // One row for the Board and its two decisions; neither decision nor the Try has its own row.
  await expect(board).toHaveAttribute("aria-label", "Try Board · rev 7 · 2 decisions")
  await expect(band.locator(".nav-decision", { hasText: "Board r7" })).toHaveCount(0)
  await expect(band.locator('.nav-try[data-kind="try"][data-nav-item="surface:board"]')).toHaveCount(0)
  // A decision about an older revision says so.
  await expect(band.locator('[data-nav-item="surface:chart"]')).toContainText("decision is about rev 5")
  // An answered decision rides on its still-fresh Try; it is a plain Try.
  const gallery = band.locator('.nav-try[data-kind="try"][data-nav-item="surface:gallery"]')
  await expect(gallery).toContainText("you chose Develop")
  // No explicit reference: the decision and the same-titled Try stay two rows.
  await expect(band.locator(".nav-decision", { hasText: "Pick a retention window" })).toHaveCount(1)
  await expect(band.locator('[data-kind="try"][data-nav-item="surface:notes"]')).toHaveCount(1)
  await expect(band.locator('.nav-decision[data-kind="decision"]', { hasText: "Notes" })).toHaveCount(1)
  // Another host's pair is one row and keeps its host.
  const map = band.locator('[data-kind="try-decision"][data-nav-item="mini~surface:map"]')
  await expect(map).toHaveAttribute("aria-label", "Try Map · rev 2 · decision · on Mac Mini")
  // Count: Board, Chart, Gallery, retention, Notes decision, Notes Try, Mini map = 7 items, one each.
  await expect(band.locator(".nav-heading-count")).toHaveText("7")
  // The Decisions tab lists the pair once too.
  await sidebar.getByRole("tab", { name: /^Decisions/ }).click()
  await expect(sidebar.locator('[role=tabpanel] [data-kind="try-decision"][data-nav-item="surface:board"]')).toHaveCount(1)

  // Opening it opens the Surface reader with both decisions' own answer controls inline.
  await board.click()
  await expect(page).toHaveURL(/[?&](surface=board|item=surface%3Aboard)$/)
  await expect(page.locator(".desk-surface h2")).toContainText("Board")
  const panel = page.getByRole("complementary", { name: "2 decisions about this" })
  // Compact until asked: one banner for both, expanded on demand.
  await panel.getByRole("button", { name: /^2 decisions/ }).click()
  const first = panel.locator('article.home-decision[data-attention-id="pair_1"]')
  await expect(first.getByRole("button", { name: "Park", exact: true })).toBeVisible()
  await expect(panel.locator('article.home-decision[data-attention-id="pair_2"]')).toBeVisible()
  // Viewing marks the revision seen; that is not an answer.
  await expect.poll(() => seen.length).toBeGreaterThan(0)
  expect(commands()).toEqual([])
  await expect(board).toBeVisible()
  // Answering in the reader is the record's own answer command.
  await first.getByRole("button", { name: "Park", exact: true }).click()
  await expect.poll(() => commands().length).toBe(1)
  expect(commands()[0].body).toMatchObject({ action: "answer", choice_id: "park" })
  expect(commands()[0].path).toContain("pair_1")

  // A stale pair says which revision the decision is about.
  await page.goto(`${preview.url}/?surface=chart`)
  await page.locator(".surface-decisions-banner").click()
  await expect(page.locator(".surface-decision-stale")).toHaveText("decision is about rev 5 · showing rev 7")

  // Another host's pair opens that host's Surface here with that host's decision.
  await page.goto(`${preview.url}/?item=${encodeURIComponent("mini~surface:map")}`)
  await page.getByRole("complementary", { name: "Decision about this" }).locator(".surface-decisions-banner").click()
  await expect(page.getByRole("complementary", { name: "Decision about this" }).locator(`article.home-decision[data-attention-id="${miniRecord.id}"]`)).toBeVisible()

  // 390px RTL: the reader keeps the decision controls on screen.
  await page.goto(`${preview.url}/?surface=board`)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.locator(".surface-decisions-banner").click()
  const answer = page.locator('article.home-decision[data-attention-id="pair_2"]').getByRole("button", { name: "Develop", exact: true })
  await answer.scrollIntoViewIfNeeded()
  const box = await answer.boundingBox()
  if (!box || box.x < 0 || box.x + box.width > 390) throw new Error(`clipped at 390px RTL: ${JSON.stringify(box)}`)
  await page.screenshot({ path: "/tmp/artifact-try-rtl-390.png" })
  expect(errors).toEqual([])
  console.log("PASS artifact try unification: one row per artifact (local, several decisions, stale revision, remote host), answered outcome on a plain Try, no reference keeps two rows, reader answers inline, view is not an answer, 390px RTL")
} finally {
  await browser.close()
  await preview.close()
}

// NAV-01/02: the Front desk page has no second decision list. The sidebar (Needs you, Decisions tab) is the one list;
// the main pane shows the open item, or with nothing open an overview of what the sidebar does not list (waiting,
// history, ignored, memory, sources). Opening keeps deep links, Back and reload; a Mini decision is answered on the
// Mini. Shots before/after at 1440, 390 and RTL. Run from packages/es-app: node test/desk-one-list.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
preview.ledger.operator = true
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const miniOrigin = "http://127.0.0.1:65031"
const miniDir = "/Users/mini/fixture"
let miniDown = false
const now = Date.now()
// Same record ID as the local fixture decision ("decision_1"): two entries, one per host.
const miniDecision = { id: "decision_1", editspace: "fixture", revision: 2, status: "open", kind: "decision", title: "Rotate the Mini certs?", context: "The Mini's TLS certs expire Friday.",
  options: [{ id: "now", label: "Rotate now" }, { id: "later", label: "Next week" }], producer_session: "ses_m", origin_session: "ses_m", gate_key: "mini:certs", source_ref: { session_id: "ses_m", directory: miniDir },
  decision: null, delivery_state: "not-requested", created_at: now - 60_000, updated_at: now - 60_000, snoozed_until: null }
const permission = { id: "per_mini", sessionID: "ses_m", permission: "bash", patterns: ["make deploy"], metadata: { command: "make deploy" }, always: [] }
const request = { kind: "permission", id: "per_mini", session: "ses_m", directory: miniDir, title: "Mini deploy", project: "fixture", state: "pending", checked: now, permission }
const surfaces = [
  { id: "srf_file", title: "Mini cost report", summary: null, kind: "path", owner: "reports", lane: null, editspace: "fixture", updated_at: now - 5_000, revision: 1, health: { state: "ok" } },
  { id: "srf_url", title: "Mini live board", summary: null, kind: "url", owner: "relay", lane: null, editspace: "fixture", updated_at: now - 9_000, revision: 1, health: { state: "ok" } },
]
const miniWrites = []
await page.route(url => { const u = new URL(url); return u.origin !== preview.origin && u.origin !== miniOrigin }, route => route.abort())
await page.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url }, { id: "mini", label: "Mac Mini", origin: miniOrigin }] } }))
// Never reached: opening must not switch to the Mini's own listener.
const flipped = []
await page.route(`${miniOrigin}/**`, route => { flipped.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<title>Mini</title>" }) })
await page.route("**/hosts/mini/**", async route => {
  if (miniDown) return route.abort("connectionrefused")
  const url = new URL(route.request().url())
  const method = route.request().method()
  if (method !== "GET") miniWrites.push(`${method} ${url.pathname}`)
  const path = url.pathname.replace(/^\/hosts\/mini/, "")
  if (path === "/oc/experimental/session") return route.fulfill({ json: [{ id: "ses_m", title: "Mini worker", directory: miniDir, time: { created: 1, updated: now } }] })
  if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniDir}/.editspace` }], default: "fixture" } })
  if (path === "/es/api/attention" && method === "GET") return route.fulfill({ json: { records: [miniDecision], projects: [{ editspace: "fixture", available: true }], partial: false, limit: 200,
    inputs: { schema: "needs-you-inputs/1", boot: "b", rev: 1, requests: [request], failures: [], ignores: [], deliverables: [],
      sources: { requests: { checked_at: now, ok: true }, failures: { checked_at: now, ok: true }, ignores: { checked_at: now, ok: true }, deliverables: { checked_at: now, ok: true } } } } })
  if (path === "/es/api/attention/session") return route.fulfill({ json: { operator: true, answer: true } })
  if (path === `/es/api/attention/${miniDecision.id}`) return route.fulfill({ json: { record: miniDecision, events: [] } })
  if (path === `/es/api/attention/${miniDecision.id}/commands`) {
    const body = route.request().postDataJSON()
    Object.assign(miniDecision, { status: "answered", revision: miniDecision.revision + 1, answer: { id: "a", text: "", choice_id: body.choice_id, answered_at: Date.now() }, delivery_state: "pending" })
    return route.fulfill({ json: { record: miniDecision } })
  }
  if (path === "/es/api/surfaces") return route.fulfill({ json: { surfaces } })
  if (path === "/__es/surface/srf_file") return route.fulfill({ json: { src: "/hosts/mini/__es/frame/srf_file", expires_at: Date.now() + 600_000 } })
  if (path === "/__es/frame/srf_file") return route.fulfill({ contentType: "text/html", body: "<h1>Mini cost report body</h1>" })
  if (path === "/oc/permission") return route.fulfill({ json: [permission] })
  if (path === "/oc/question") return route.fulfill({ json: [] })
  if (path === "/oc/permission/per_mini/reply") return route.fulfill({ json: true })
  return route.fulfill({ json: [] })
})
const sidebar = page.locator("nav.sidebar")
const band = sidebar.getByRole("region", { name: "Needs you" })
const main = page.locator(".desk-grid")
const shot = async (name) => page.screenshot({ path: `/tmp/desk-one-list-${name}.png` })
try {
  // An answered record so History has something.
  preview.ledger.records.push({ ...preview.ledger.records[0], id: "decision_done", title: "Earlier choice", status: "answered", revision: 3,
    answer: { id: "a1", text: "", choice_id: "small", answered_at: Date.now() - 3_600_000 }, delivery_state: "handled" })
  await page.goto(`${preview.url}/`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(band.locator("[data-nav-item='attention:fixture:decision_1']")).toBeVisible({ timeout: 120_000 })
  // No second list: no queue aside, no Needs you or Surfaces lists in the main pane.
  await expect(page.locator("aside.desk-queue")).toHaveCount(0)
  await expect(main.getByRole("heading", { name: /^Needs you/ })).toHaveCount(0)
  await expect(main.locator(".desk-surfaces, .desk-deliverables")).toHaveCount(0)
  // Nothing open: the overview keeps what only it shows.
  const overview = page.getByRole("region", { name: "Decisions and inbox" })
  await expect(page.getByRole("heading", { name: "Decisions & inbox" })).toBeVisible()
  await expect(overview.locator(".desk-history summary")).toContainText("History")
  await expect(overview.getByRole("button", { name: /^Memory/ })).toBeVisible()
  await expect(overview.locator(".desk-sources")).toBeVisible()
  await shot("overview-1440")
  await overview.locator(".desk-history summary").click()
  await overview.getByRole("button", { name: /Earlier choice/ }).click()
  await expect(page).toHaveURL(/item=attention(%3A|:)fixture(%3A|:)decision_done/)
  await expect(overview).toHaveCount(0)

  // Open from the sidebar: the detail fills the main pane; reload reopens it; Back goes to the previous item.
  await band.locator("[data-nav-item='attention:fixture:decision_1']").click()
  const detail = page.locator(".desk-evidence[aria-label='Selected item']")
  await expect(detail).toBeVisible()
  const width = await page.evaluate(() => [document.querySelector(".desk-evidence").getBoundingClientRect().width, document.querySelector(".desk-grid").getBoundingClientRect().width])
  if (width[0] < width[1] * 0.9) throw new Error(`detail does not fill the main pane: ${width}`)
  // A local decision keeps its brief controls: Prepare brief (request), the brief lead slot and More detail (ask).
  await expect(detail.getByRole("button", { name: "Prepare brief" })).toBeAttached()
  await expect(detail.locator(".desk-brief").first()).toBeAttached()
  await expect(detail.getByRole("button", { name: "More detail" })).toBeVisible()
  await shot("detail-1440")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(detail).toBeVisible({ timeout: 120_000 })
  // Back returns to the previously open item (opening from the overview replaces, the sidebar link pushes).
  await page.goBack()
  await expect(page).toHaveURL(/item=attention(%3A|:)fixture(%3A|:)decision_done/)
  await expect(detail).toContainText("Earlier choice")

  // A Mini decision opens here and is answered on the Mini.
  const miniRow = band.locator("[data-nav-item='mini~attention:fixture:decision_1']")
  await miniRow.click()
  const remote = page.locator(".work-remote")
  await remote.getByRole("radio", { name: "Rotate now" }).check()
  await remote.getByRole("button", { name: "Send Rotate now" }).click()
  await expect.poll(() => miniWrites.filter(write => write.endsWith(`/${miniDecision.id}/commands`)).length).toBe(1)
  expect(flipped).toEqual([])

  // Narrow and RTL.
  await band.locator("[data-nav-item='attention:fixture:decision_1']").click()
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("detail-390")
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (overflow > 1) throw new Error(`RTL 390px overflows by ${overflow}px`)
  await shot("detail-390-rtl")
  expect(errors).toEqual([])
  console.log("desk-one-list: PASS")
} finally {
  await browser.close()
  await preview.close()
}

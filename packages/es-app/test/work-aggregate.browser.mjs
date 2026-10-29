// Main1555 Work aggregate UI: another Work host's decision, permission and Surfaces open in THIS window (no switch to
// that host's tab); reads and actions go through /hosts/mini/. Same decision ID on both hosts stays two entries;
// a link Surface on the Mini says it is served there only; when the Mini stops answering, its entries stay last-known
// and counts read "N+". Also 390px RTL. Disposable fixture. Run from packages/es-app: node test/work-aggregate.browser.mjs
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
const detail = page.locator(".work-remote")
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  // Both decision_1 entries: the local one and the Mini's, host-qualified.
  const miniRow = band.locator("[data-nav-item='mini~attention:fixture:decision_1']")
  await expect(miniRow).toBeVisible({ timeout: 120_000 })
  await expect(band.locator("[data-nav-item='attention:fixture:decision_1']")).toHaveCount(1)
  await expect(miniRow).toHaveAttribute("href", /^\/\?item=/)

  // The Mini's decision opens here and is answered on the Mini.
  await miniRow.click()
  await expect(detail).toHaveAttribute("data-work-key", "mini~attention:fixture:decision_1")
  await expect(detail.locator(".work-remote-host")).toContainText("on Mac Mini")
  await expect(detail.getByText("The Mini's TLS certs expire Friday.")).toBeVisible()
  await expect(miniRow).toHaveAttribute("aria-current", "page")
  await detail.getByRole("radio", { name: "Rotate now" }).check()
  await detail.getByRole("button", { name: "Send Rotate now" }).click()
  await expect.poll(() => miniWrites.filter(write => write.endsWith(`/${miniDecision.id}/commands`)).length).toBe(1)
  expect(preview.ledger.calls.filter(call => call.path.endsWith("/commands"))).toEqual([])

  // The Mini's permission: validated on the Mini, approved on the Mini.
  const permissionRow = band.locator("[data-nav-item^='mini~permission:']")
  await expect(permissionRow).toBeVisible()
  await permissionRow.click()
  await expect(detail.getByText("make deploy").first()).toBeVisible()
  await detail.getByRole("button", { name: /^Allow once/ }).click()
  await expect.poll(() => miniWrites.includes("POST /hosts/mini/oc/permission/per_mini/reply")).toBe(true)

  // Surfaces tab: the Mini's file Surface frames through the Mini; its link Surface says where it lives.
  await sidebar.getByRole("tab", { name: /^Surfaces/ }).click()
  await sidebar.locator("[data-nav-item='mini~surface:srf_file']").click()
  await expect(detail.frameLocator("iframe").getByText("Mini cost report body")).toBeVisible()
  await sidebar.locator("[data-nav-item='mini~surface:srf_url']").click()
  await expect(detail.locator("[data-surface-gap=own-host-only]")).toContainText("served only on Mac Mini")
  expect(flipped).toEqual([])

  // RTL, narrow: the host line and detail stay inside the viewport.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await sidebar.locator("[data-nav-item='mini~surface:srf_file']").scrollIntoViewIfNeeded()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (overflow > 1) throw new Error(`RTL 390px overflows by ${overflow}px`)
  await page.screenshot({ path: "/tmp/work-aggregate-rtl-390.png" })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.setViewportSize({ width: 1280, height: 900 })

  // The Mini stops answering: its entries stay, last-known, and counts read "N+".
  miniDown = true
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(sidebar.getByRole("tab", { name: /^Surfaces/ }).locator(".nav-tab-count")).toHaveText(/\+$/, { timeout: 120_000 })
  expect(errors).toEqual([])
  console.log("work-aggregate: PASS")
} finally {
  await browser.close()
  await preview.close()
}

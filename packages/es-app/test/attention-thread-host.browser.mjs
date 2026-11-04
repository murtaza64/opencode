// An attention card's thread links open on the record's own host (DD #787): a Laptop viewer of a Mac Mini record gets
// the Mini session route (`&host=mini`) and the session page says when that host cannot show it; this host's record keeps
// the local route. Disposable fixture; no writes. Run from packages/es-app.
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const now = Date.now()
const record = (id, fields) => ({ id, editspace: "fixture", revision: 1, status: "open", kind: "decision", options: [{ id: "ok", label: "OK" }],
  producer_session: "ses_a", origin_session: "ses_a", gate_key: `${id}:v1`, source_ref: { session_id: "ses_a", directory }, decision: null,
  delivery_state: "not-requested", created_at: now - 60_000, updated_at: now - 60_000, snoozed_until: null, artifact: null, title: "Pick one", context: "Either.", ...fields })
preview.ledger.records = [record("local_1", {})]
const mini = "http://127.0.0.1:65021"
const miniRecord = record("ee6e8a78-96da-4793-a6b1-0b50424dc3ee", { title: "Google read-only access", source_ref: { session_id: "ses_minithread", directory: "/Users/mini/opencode/.editspace" } })
const results = []
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/__es/host", route => route.fulfill({ json: { id: "laptop", label: "Laptop", remote: false, hosts: [], work: [
  { id: "laptop", label: "Laptop", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: mini }] } }))
await context.route("**/hosts/mini/**", route => {
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: [] })
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (url.pathname === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [miniRecord], projects: [], partial: false, limit: 200 } })
  if (url.pathname === `/hosts/mini/es/api/attention/${miniRecord.id}`) return route.fulfill({ json: { record: miniRecord, events: [] } })
  if (url.pathname === "/hosts/mini/es/api/surfaces") return route.fulfill({ json: { surfaces: [] } })
  // The Mini's session reads are unreachable in this fixture: the page must say so, not open a local thread.
  return route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"Host unavailable"}' })
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const card = id => page.locator(`article.home-decision[data-attention-id="${id}"]`)
try {
  await page.goto(`${preview.url}/?item=${encodeURIComponent("attention:fixture:local_1")}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const local = card("local_1").getByRole("link", { name: "Open source thread" })
  await expect(local).toHaveAttribute("href", `/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 120_000 })
  results.push("PASS this host's record: the thread link is the local route")

  await page.goto(`${preview.url}/?item=${encodeURIComponent(`mini~attention:fixture:${miniRecord.id}`)}`, { waitUntil: "domcontentloaded" })
  const remote = card(miniRecord.id).getByRole("link", { name: "Open source thread" })
  const href = `/session/ses_minithread?directory=${encodeURIComponent("/Users/mini/opencode/.editspace")}&host=mini`
  await expect(remote).toHaveAttribute("href", href, { timeout: 120_000 })
  results.push("PASS a Mac Mini record viewed on the Laptop: the thread link carries host=mini")
  await remote.click()
  await expect(page).toHaveURL(`${preview.url}${href}`)
  await expect(page.locator(".session-host")).toContainText("Mac Mini")
  await expect(page.locator(".host-session-offline")).toBeVisible({ timeout: 30_000 })
  results.push("PASS following it opens the Mini thread view, which says the Mini cannot show it now (no local stand-in)")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n").slice(0, 8).join(" | ")}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
}

// A Work host's lane pin follows a handoff promptly. The Mini's synced store pins lane:fixture/orchestrator; its owner
// P hands off to S the way `es` does it: S is created (and listed) first, and the lane owner is stamped a moment later.
// The pinned row moves from P to S within seconds of the stamp, not at the next 60 s lineage interval.
// Run from packages/es-app: node test/host-lane-pin-follow.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const dir = "/Users/mini/fixture/.editspace/lanes/orchestrator/repos/o/r"
const row = (id) => ({ id, title: `Mini ${id}`, directory: dir, time: { created: 1, updated: Date.now() } })
let rows = [row("P")]
let owner = "P"
const lineageReads = []
const reads = {}
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "laptop", label: "Laptop", remote: false, profile: "work", hosts: [], work: [
  { id: "laptop", label: "Laptop", origin: preview.fixture.url, profile: "work" },
  { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:65001", profile: "work" },
] } }))
// No stream multiplexer in the preview: host streams use plain EventSource through the routes below.
await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
await page.route("**/hosts/mini/**", (route) => {
  const url = new URL(route.request().url())
  reads[url.pathname] = (reads[url.pathname] ?? 0) + 1
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: rows })
  // Each stream ends at once and reconnects, so the feed re-reads its list every second (as session events would).
  if (url.pathname === "/hosts/mini/oc/global/event") return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "retry: 1000\n\n" })
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (url.pathname === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [] } })
  if (url.pathname === "/hosts/mini/es/api/pins") return route.fulfill({ json: { rev: 1, profile: "work", pins: [{ ref: "lane:fixture/orchestrator", pinnedAt: 1, order: null, orderAt: null }], tombstones: [] } })
  if (url.pathname === "/hosts/mini/es/api/handoffs") {
    lineageReads.push(Date.now())
    return route.fulfill({ json: { handoffs: owner === "S" ? [{ lane: "orchestrator", predecessor: "P", successor: "S" }] : [] } })
  }
  if (url.pathname === "/hosts/mini/es/api/state") return route.fulfill({ json: { editspace: "fixture", threads: [{ lanes: [{ lane: "orchestrator", owner }] }] } })
  return route.fulfill({ status: 403, body: "not exposed" })
})
const pinned = (id) => page.locator(`.sidebar .pinned-section .nav-item[data-host-key='mini:${id}']`)
try {
  await page.goto(preview.url)
  await expect(pinned("P")).toBeVisible({ timeout: 30_000 })
  // The successor is listed before its owner stamp: the lane pin stays on P until the stamp lands.
  rows = [row("P"), row("S")]
  await expect.poll(() => lineageReads.length, { timeout: 10_000 }).toBeGreaterThan(1)
  await expect(pinned("P")).toBeVisible()
  owner = "S"
  const stamped = Date.now()
  await expect(pinned("S")).toBeVisible({ timeout: 15_000 })
  await expect(pinned("P")).toHaveCount(0)
  console.log(`PASS host lane pin follow: lane pin moved P -> S ${Math.round((Date.now() - stamped) / 1000)} s after the owner stamp (lineage interval 60 s)`)
} catch (error) {
  console.log("reads", JSON.stringify(reads))
  throw error
} finally {
  await browser.close()
  await preview.close()
}

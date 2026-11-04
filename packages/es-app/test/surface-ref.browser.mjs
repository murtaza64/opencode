// One citable Surface ref (DD #740): `/?item=<own host>~surface%3A<id>` opens this host's Surface locally; `&rev=N`
// for an older revision says so and shows the current one only on request (no frame before); the current revision
// opens directly; a ref to a host this app does not read says why instead of a blank pane. Run from packages/es-app.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const results = []
const setup = async (page) => {
  await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "mini", label: "Mac Mini", remote: false, hosts: [] } }))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [
    { id: "ops", title: "Ops report", summary: null, kind: "path", owner: "fixture", lane: null, editspace: "fixture", updated_at: now, revision: 2, health: { state: "ok" } }] } }))
  await page.route("**/__es/surface/ops", (route) => route.fulfill({ json: { src: "/__cap/surface/ops/m1-0123456789abcdef0123456789abcdef/", expires_at: now + 600_000 } }))
  await page.route("**/__cap/surface/ops/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Ops report body</h1>" }))
}
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  await setup(page)
  await page.goto(`${preview.origin}/?item=mini~surface%3Aops`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.locator(".desk-surface-frame")).toHaveCount(1, { timeout: 120_000 })
  await expect(page.locator(".surface-head h2")).toContainText("Ops report")
  results.push("PASS a self-qualified ref opens this host's Surface locally")

  await page.goto(`${preview.origin}/?item=mini~surface%3Aops&rev=1`, { waitUntil: "domcontentloaded" })
  const notice = page.locator('[data-cited-revision="older"]')
  await expect(notice).toContainText("You were sent rev 1. This Surface is now at rev 2; rev 1 is no longer available.", { timeout: 60_000 })
  await expect(page.locator(".desk-surface-frame")).toHaveCount(0)
  await notice.getByRole("button", { name: "Open rev 2 (current)" }).click()
  await expect(page.locator(".desk-surface-frame")).toHaveCount(1)
  results.push("PASS an older cited revision is named and the current one opens only on request")

  await page.goto(`${preview.origin}/?item=mini~surface%3Aops&rev=2`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".desk-surface-frame")).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator("[data-cited-revision]")).toHaveCount(0)
  await page.goto(`${preview.origin}/?item=mini~surface%3Aops&rev=9`, { waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-cited-revision="unpublished"]')).toContainText("rev 9, which this host has not published", { timeout: 60_000 })
  results.push("PASS the current cited revision opens directly; an unpublished one is refused")

  await page.goto(`${preview.origin}/?item=pc~surface%3Aops`, { waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-surface-gap="ref"]')).toContainText("pc is not a Work host this app reads", { timeout: 60_000 })
  await expect(page.locator(".desk-surface-frame")).toHaveCount(0)
  results.push("PASS a ref to a host this app does not read says why, with no substituted copy")

  // A Surface this host withdrew (tombstone) reads as withdrawn; an id it never listed reads as not found.
  await page.unroute((url) => new URL(url).pathname === "/es/api/surfaces")
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [], withdrawn: [
    { id: "old-report", title: "Old report", owner: "opencode/lane-a", editspace: "opencode", revision: 3, withdrawn_at: now }] } }))
  await page.goto(`${preview.origin}/?item=mini~surface%3Aold-report`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".desk-surface-state").first()).toContainText("opencode/lane-a withdrew this Surface at rev 3", { timeout: 60_000 })
  await page.goto(`${preview.origin}/?item=mini~surface%3Anever-was`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".desk-surface-state").first()).toContainText("never published there", { timeout: 60_000 })
  results.push("PASS a withdrawn Surface reads as withdrawn by its owner at its last revision; an unknown one as not found")
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n").slice(0, 8).join(" | ")}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
}

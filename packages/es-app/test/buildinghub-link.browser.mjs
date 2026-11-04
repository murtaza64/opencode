// DD #782 (was Laptop2649): the reader's More menu says where the Surface is on BuildingHub. A copy built from this
// revision is linked with Copy link; an older or different copy is named without a link; no receipt says "Not on
// BuildingHub". Fake Surface rows; nothing reaches BuildingHub.
// Run from packages/es-app: node test/buildinghub-link.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const url = "https://diff-stream.buildinghub.duolingo.com/#/s/diff-stream"
const row = (id, buildinghub) => ({ id, title: id, summary: null, kind: "path", owner: "Fixture lead", lane: null, editspace: "fixture",
  updated_at: Date.now(), revision: 4, health: { state: "ok" }, purpose: "board", ...(buildinghub ? { buildinghub } : {}) })
const surfaces = [
  row("current", { state: "deployed", url, version: "v4", current: true, copy: "current", source_revision: 4 }),
  row("older", { state: "building", version: "v5", current: false, copy: "older", last_deployed: { url, version: "v4", source_revision: 3 } }),
  row("different", { state: "deployed", url, version: "v2", current: false, copy: "different" }),
  row("none"),
]
const outside = []
await page.route((target) => new URL(target).hostname.endsWith("buildinghub.duolingo.com"), (route) => { outside.push(route.request().url()); return route.abort() })
await page.route("**/es/api/surfaces", (route) => route.fulfill({ json: { surfaces } }))
await page.route((target) => /\/__es\/surface\/[^/]+$/.test(new URL(target).pathname), (route) => route.fulfill({ json: { src: "about:blank" } }))
const results = []
const slot = page.locator(".surface-head [data-slot=buildinghub]")
const more = () => page.locator(".surface-head .surface-more > summary").click()
try {
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:current")}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(page.locator(".surface-head h2")).toHaveText("current", { timeout: 120_000 })
  await more()
  await expect(slot.locator("a")).toHaveText("On BuildingHub: v4 from r4")
  await expect(slot.locator("a")).toHaveAttribute("href", url)
  await expect(slot.locator("a")).toHaveAttribute("target", "_blank")
  await expect(slot.getByRole("button", { name: "Copy link" })).toHaveCount(1)
  results.push("PASS this revision's copy: verified BuildingHub link and Copy link")
  for (const [id, text] of [["older", "BuildingHub copy v4 is from r3 (older than r4)"], ["different", "BuildingHub has a different copy v2"], ["none", "Not on BuildingHub"]]) {
    await page.goto(`${preview.origin}/?item=${encodeURIComponent(`surface:${id}`)}`, { waitUntil: "domcontentloaded" })
    await expect(page.locator(".surface-head h2")).toHaveText(id)
    await more()
    await expect(slot).toHaveText(text)
    await expect(slot.locator("a")).toHaveCount(0)
  }
  results.push("PASS an older or different copy is named with no link; no receipt says Not on BuildingHub")
  if (outside.length) throw new Error(`requests to BuildingHub: ${outside.length}`)
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
}

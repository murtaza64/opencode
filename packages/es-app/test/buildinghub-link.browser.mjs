// Laptop2649: a Surface with a deployed BuildingHub receipt shows a named "BuildingHub version" link in its header slot;
// an older deploy says so; a Surface without a deploy shows nothing. Fake Surface rows; nothing reaches BuildingHub.
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
  row("current", { state: "deployed", url, version: "v4", current: true }),
  row("older", { state: "building", version: "v5", current: false, last_deployed: { url, version: "v4" } }),
  row("none"),
]
const outside = []
await page.route((target) => new URL(target).hostname.endsWith("buildinghub.duolingo.com"), (route) => { outside.push(route.request().url()); return route.abort() })
await page.route("**/es/api/surfaces", (route) => route.fulfill({ json: { surfaces } }))
await page.route((target) => /\/__es\/surface\/[^/]+$/.test(new URL(target).pathname), (route) => route.fulfill({ json: { src: "about:blank" } }))
const results = []
const slot = page.locator(".surface-head [data-slot=buildinghub]")
try {
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:current")}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(slot.locator("a")).toHaveText("BuildingHub version v4")
  await expect(slot.locator("a")).toHaveAttribute("href", url)
  await expect(slot.locator("a")).toHaveAttribute("data-current", "current")
  await expect(slot.locator("a")).toHaveAttribute("target", "_blank")
  results.push("PASS a current deploy: named link to BuildingHub version v4")
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:older")}`, { waitUntil: "domcontentloaded" })
  await expect(slot.locator("a")).toHaveText("BuildingHub version v4 (older)")
  await expect(slot.locator("a")).toHaveAttribute("data-current", "older")
  results.push("PASS a redeploy in progress: links to the last deploy, marked older")
  await page.goto(`${preview.origin}/?item=${encodeURIComponent("surface:none")}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".surface-head h2")).toHaveText("none")
  await expect(slot).toBeHidden()
  await expect(slot.locator("a")).toHaveCount(0)
  results.push("PASS no deploy receipt: nothing in the slot")
  if (outside.length) throw new Error(`requests to BuildingHub: ${outside.length}`)
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
}

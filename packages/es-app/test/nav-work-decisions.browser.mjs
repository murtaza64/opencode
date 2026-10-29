// Unified nav slice 2 (dotfiles#240): the Needs you band and the Decisions tab list every Work host's open
// decisions after this host's, each with its host glyph and name; another host's decision opens on that
// host's own Front desk. A host that stops answering keeps its last-known decisions, dimmed, and the count
// reads "N+" naming it. Disposable fixture; no writes. Run from packages/es-app: node test/nav-work-decisions.browser.mjs
import { selectScope } from "./scope.mjs"
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const mini = "http://127.0.0.1:65011"
let miniDown = false
const decision = (id, title) => ({ id, editspace: "fixture", revision: 1, status: "open", kind: "decision", title, options: [], delivery_state: "not-requested", created_at: Date.now() - 60_000 })
await page.route(url => new URL(url).origin !== preview.origin && !url.toString().startsWith(mini), route => route.abort())
await page.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url }, { id: "mini", label: "Mac Mini", origin: mini }] } }))
await page.route("**/hosts/mini/**", route => {
  if (miniDown) return route.abort("connectionrefused")
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: [] })
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (url.pathname === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [decision("33333333-3333-4333-8333-333333333333", "Rotate the Mini certs?")], projects: [], partial: false } })
  return route.fulfill({ status: 403, body: "not exposed" })
})
const opened = []
await page.route(`${mini}/**`, route => { opened.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<title>Mini</title>" }) })
const sidebar = page.locator("nav.sidebar")
const band = sidebar.getByRole("region", { name: "Needs you" })
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const miniRow = band.getByRole("link", { name: /^Rotate the Mini certs\?, decision, on Mac Mini$/ })
  await expect(miniRow).toBeVisible({ timeout: 120_000 })
  await expect(miniRow.locator(".host-glyph")).toHaveCount(1)
  // This host's items come first.
  const titles = await band.locator(".nav-decision .nav-title").allTextContents()
  if (titles.indexOf("Rotate the Mini certs?") < titles.indexOf("Choose the bounded implementation scope")) throw new Error(`local first: ${titles}`)
  // The Decisions tab lists it too and filters by host name.
  await sidebar.getByRole("tab", { name: /^Decisions/ }).click()
  const panel = sidebar.locator("[role=tabpanel]")
  await panel.getByRole("searchbox", { name: "Filter Decisions" }).fill("mac mini")
  await expect(panel.locator(".nav-decision")).toHaveCount(1)
  await panel.getByRole("searchbox", { name: "Filter Decisions" }).fill("")
  // Opening it goes to the Mini's own Front desk with the record selected.
  await miniRow.click()
  await expect.poll(() => opened.at(-1)).toBe(`${mini}/desk?item=${encodeURIComponent("attention:fixture:33333333-3333-4333-8333-333333333333")}`)
  await page.goto(`${preview.url}/agents`)
  await expect(miniRow).toBeVisible({ timeout: 60_000 })
  // The Mini stops answering: its decision stays, dimmed, and the count is partial and names it.
  miniDown = true
  await selectScope(page, "__all__")
  await selectScope(page, "fixture")
  const stale = band.getByRole("link", { name: /^Rotate the Mini certs\?, decision, on Mac Mini, last known$/ })
  await expect(stale).toBeVisible({ timeout: 60_000 })
  await expect(band.locator(".nav-heading-count")).toHaveText(/\+$/)
  await expect(band.locator(".nav-heading-count")).toHaveAttribute("title", "Mac Mini: not current")
  console.log("PASS nav work decisions: Mini decision in band + Decisions tab with host glyph, local first, host filter, opens on the Mini desk, unreachable host kept dimmed with N+ naming it")
} finally {
  await browser.close()
  await preview.close()
}

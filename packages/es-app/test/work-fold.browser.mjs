// Unified Work (dotfiles#240): the agent list shows every Work host (this machine and the Mini) by default; the Filter
// popover (Laptop2677) holds one checkbox per host. Hiding one is remembered across a reload, a host added later is shown, a stored
// choice that would hide everything shows all, and the Needs you band is never filtered by it. A Personal page has
// no Work strip. Disposable fixture; no writes. Run from packages/es-app: node test/work-fold.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { closeFilter, openFilter } from "./scope.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const mini = "http://127.0.0.1:65021"
const miniRoot = "/Users/mini/fixture"
const setup = async (page, profile = "work") => {
  await page.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Laptop", remote: false, profile, hosts: [], work: [
    { id: "local", label: "Laptop", origin: preview.fixture.url }, { id: "mini", label: "Mac Mini", origin: mini, default: true }] } }))
  await page.route("**/hosts/mini/**", route => {
    const url = new URL(route.request().url())
    if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: [{ id: "ses_mini", title: "Mini only", directory: miniRoot, time: { created: 1, updated: Date.now() } }] })
    if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniRoot}/.editspace` }], default: "fixture" } })
    if (url.pathname === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [{ id: "44444444-4444-4444-8444-444444444444", editspace: "fixture", revision: 1, status: "open", kind: "decision", title: "Mini decision", options: [], delivery_state: "not-requested", created_at: Date.now() - 1000 }], projects: [], partial: false } })
    return route.fulfill({ status: 403, body: "no" })
  })
  await page.route(`${mini}/**`, route => route.fulfill({ contentType: "text/html", body: "<title>Mini</title>" }))
}
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/*", route => { const url = route.request().url(); return url.startsWith(preview.origin) || url.startsWith(mini) ? route.fallback() : route.abort() })
await context.addInitScript(() => localStorage.setItem("es-app:nav-tab", "agents"))
const page = await context.newPage()
page.setDefaultTimeout(60_000)
await setup(page)
const host = async name => (await openFilter(page)).getByRole("checkbox", { name: new RegExp(name) })
const list = page.locator(".sidebar [role=tabpanel]")
const miniRow = () => list.getByRole("link", { name: /^Mini only, on Mac Mini$/ })
const localRow = () => list.locator(".session-entry .nav-title", { hasText: "Other session" })
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  // Default: Work named, both hosts on, rows from both listed.
  await expect(miniRow()).toBeVisible({ timeout: 120_000 })
  await expect(await host("Laptop")).toBeChecked()
  await expect(await host("Mac Mini")).toBeChecked()
  await closeFilter(page)
  await expect(miniRow()).toBeVisible()
  await expect(localRow()).toHaveCount(1)
  // Hide the Mini: its rows leave the list but its decision stays in Needs you; the choice survives a reload.
  await (await host("Mac Mini")).click()
  await closeFilter(page)
  await expect(miniRow()).toHaveCount(0)
  await expect(page.locator(".sidebar .filtered-out")).toContainText("1 hidden by filters")
  await expect(page.getByRole("region", { name: "Needs you" }).getByText("Mini decision")).toBeVisible()
  await page.reload()
  await expect(page.locator(".sidebar .filtered-out")).toBeVisible({ timeout: 60_000 })
  await expect(await host("Mac Mini")).not.toBeChecked()
  await closeFilter(page)
  await expect(miniRow()).toHaveCount(0)
  // The last shown host cannot be hidden.
  await (await host("Laptop")).click()
  await expect(await host("Laptop")).toBeChecked()
  await (await host("Mac Mini")).click()
  await closeFilter(page)
  await expect(miniRow()).toBeVisible()
  // A stored choice that hides every host (or unknown junk) shows all.
  await page.evaluate(() => localStorage.setItem("es-app:work-hidden-hosts", JSON.stringify(["local", "mini"])))
  await page.reload()
  await expect(miniRow()).toBeVisible({ timeout: 60_000 })
  await page.evaluate(() => localStorage.setItem("es-app:work-hidden-hosts", "{not json"))
  await page.reload()
  await expect(miniRow()).toBeVisible({ timeout: 60_000 })
  // Personal page: no Work strip.
  const personal = await context.newPage()
  await setup(personal, "personal")
  await personal.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(personal.locator(".sidebar [role=tabpanel] .session-entry").first()).toBeVisible({ timeout: 60_000 })
  await personal.locator(".sidebar-filter > summary").click()
  await expect(personal.locator(".sidebar-filter-panel legend", { hasText: "Hosts" })).toHaveCount(0)
  if (preview.fixture.calls.some(call => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session")) throw new Error("unexpected writes")
  console.log("PASS work fold: Work named, all hosts shown by default, hide survives reload, last host stays, bad stored state shows all, Needs you unfiltered, Personal has no host choices; no writes")
} finally {
  await browser.close()
  await preview.close()
}

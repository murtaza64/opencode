// Another host's handoff in the Work view (dotfiles#215, Delta on the Mini): two hosts with the same session IDs; on the
// Mini, lane "lead" in editspace "deep" handed off ses_a -> ses_b, and "deep" comes after four other editspaces in the
// Mini's rows. The Mini's lane pin resolves to its current owner ses_b; its session pin on ses_a stays (exact) with a
// "handed off ->" link; the Mini's ses_a view says "Handed off to" with a link that stays on the Mini, which shows
// "Previous session" back; reload, Back and opening the old link show the same. Local's ses_a shows no handoff.
// Disposable fixtures; no writes. Run from packages/es-app: node test/host-handoff-follow.browser.mjs
import { createRequire } from "node:module"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const mini = await createFixture()
const now = Date.now()
const other = (index) => ({ id: `ses_e${index}`, title: `Mini e${index}`, directory: `/m/e${index}`, projectID: "x", version: "1", agent: "build", time: { created: 1, updated: now - index } })
// Rows list the four other editspaces before "deep" (the fixture directory).
mini.sessionIDs = []
mini.workspaceSessions = [1, 2, 3, 4].map(other).concat([
  { id: "ses_a", title: "Delta (before handoff)", directory, projectID: "x", version: "1", agent: "build", time: { created: 1, updated: now - 100 } },
  { id: "ses_b", title: "Delta (after handoff)", directory, projectID: "x", version: "1", agent: "build", time: { created: 2, updated: now - 50 } },
])
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini\/oc(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    const upstream = httpRequest(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startPanelPreview([hostRoutes])
const editspaces = [1, 2, 3, 4].map((index) => ({ name: `e${index}`, root: `/m/e${index}/.editspace` })).concat([{ name: "deep", root: `${directory}/.editspace` }])
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await context.addInitScript(() => {
  if (sessionStorage.getItem("seeded")) return
  sessionStorage.setItem("seeded", "1")
  localStorage.setItem("es-app-all-projects", "true")
  localStorage.setItem("es-pins-migrated:mini", "1")
})
let page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const dialogs = []
page.on("dialog", (dialog) => { dialogs.push(`${dialog.type()}: ${dialog.message()}`); void dialog.accept() })
const lineageReads = []
const routes = async (page) => {
  await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "laptop", label: "Laptop", remote: false, profile: "work", hosts: [], work: [
    { id: "laptop", label: "Laptop", origin: preview.origin },
    { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net", profile: "work" },
  ] } }))
  await page.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
  await page.route("**/hosts/mini/es/**", (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/hosts\/mini/, "")
    const es = url.searchParams.get("es")
    if (route.request().method() !== "GET") return route.fulfill({ status: 403, body: "no writes in this fixture" })
    if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces, default: "e1" } })
    if (path === "/es/api/pins") return route.fulfill({ json: { rev: 1, profile: "work", pins: [
      { ref: "lane:deep/lead", pinnedAt: 1, order: null, orderAt: null }, { ref: "session:ses_a", pinnedAt: 2, order: null, orderAt: null }], tombstones: [] } })
    if (path === "/es/api/handoffs") { lineageReads.push(es); return route.fulfill({ json: { handoffs: es === "deep" ? [{ lane: "lead", predecessor: "ses_a", successor: "ses_b" }] : [] } }) }
    if (path === "/es/api/state") return route.fulfill({ json: { editspace: es, threads: es === "deep" ? [{ lanes: [{ lane: "lead", owner: "ses_b" }] }] : [] } })
    if (path === "/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false, limit: 200 } })
    return route.fulfill({ json: [] })
  })
}
await routes(page)
const pinned = { locator: (selector) => page.locator(".sidebar .pinned-section").locator(selector) }
const banner = () => page.locator(".banner.handoff-next")
const previous = () => page.locator(".banner.handoff-history[aria-label='Previous session']")
const miniA = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  // Lane pin -> ses_b on the Mini, although "deep" is the fifth editspace in the Mini's rows.
  await expect(pinned.locator(".nav-item[data-host-key='mini:ses_b']")).toBeVisible({ timeout: 120_000 })
  expect(lineageReads).toContain("deep")
  // Session pin on ses_a stays, with the successor link on that host.
  await expect(pinned.locator(".nav-item[data-host-key='mini:ses_a']")).toBeVisible()
  const next = pinned.locator(".session-entry:has(.nav-item[data-host-key='mini:ses_a']) .handoff-next-link")
  await expect(next).toContainText("handed off → Delta (after handoff)")
  await expect(next).toHaveAttribute("href", /\/session\/ses_b\?.*host=mini/)

  // The Mini's old session: "Handed off to" with a link that stays on the Mini.
  await page.goto(miniA, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".session-page[data-host='mini']")).toBeVisible()
  await expect(banner()).toContainText("Handed off to Delta (after handoff)")
  await expect(banner()).toContainText("lane lead on Mac Mini")
  await banner().getByRole("link").click()
  await expect(page).toHaveURL(/\/session\/ses_b\?.*host=mini/)
  await expect(previous()).toContainText("Previous session: Delta (before handoff)")
  await expect(previous().getByRole("link")).toHaveAttribute("href", /\/session\/ses_a\?.*host=mini/)
  await expect(banner()).toHaveCount(0)
  // Back, reload, and opening the old link directly all show the handoff.
  await page.goBack()
  await expect(banner()).toContainText("Handed off to Delta (after handoff)")
  // Reload and opening the old link in a fresh page. (Without the desktop's stream multiplexer each host view holds its
  // own event stream, and this page has used the browser's six connections to the origin.)
  await page.close()
  page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await routes(page)
  await page.goto(miniA, { waitUntil: "domcontentloaded" })
  await expect(banner()).toContainText("Handed off to Delta (after handoff)")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(banner()).toContainText("Handed off to Delta (after handoff)")

  // Local's ses_a (same ID) has no handoff.
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".session-page:not([data-host])")).toBeVisible()
  await expect(page.locator(".transcript")).toBeVisible()
  await expect(banner()).toHaveCount(0)
  await expect(previous()).toHaveCount(0)
  expect(errors).toEqual([])
  if (dialogs.length) console.log("dialogs", JSON.stringify(dialogs))
  console.log("PASS host handoff follow: Mini lane pin -> ses_b past the 4-editspace cap; session pin on ses_a kept with 'handed off ->'; Mini ses_a shows 'Handed off to' (host link), ses_b 'Previous session'; Back/reload/old link; Local ses_a none")
} finally {
  await browser.close()
  await preview.close()
  await mini.close()
}

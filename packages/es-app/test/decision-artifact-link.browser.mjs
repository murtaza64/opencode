// Decision cards link what they ask about (DD decision-card-clickable-artifact-20261103): a bare Surface route in the
// request text is a link that opens the in-app Surface reader; a record's artifact (web link or Surface) is an "Open <title> · rev N"
// button beside the title, a Surface its dashboard no longer lists reads unavailable; a card with neither shows no link or button; another host's card keeps that host in the route.
// Checked desktop, then 390px RTL. Disposable fixture; no writes. Run from packages/es-app: node test/decision-artifact-link.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const now = Date.now()
const record = (id, fields) => ({ id, editspace: "fixture", revision: 1, status: "open", kind: "decision", options: [{ id: "develop", label: "Develop" }, { id: "park", label: "Park" }],
  producer_session: "ses_a", origin_session: "ses_a", gate_key: `${id}:v1`, source_ref: { session_id: "ses_a", directory }, decision: null,
  delivery_state: "not-requested", created_at: now - 60_000, updated_at: now - 60_000, snoozed_until: null, artifact: null, ...fields })
preview.ledger.records = [
  record("route_1", { title: "Firefox soft fork r3: develop, revise or park?", context: "Surface fixture-board rev 7 (/?surface=fixture-board). Verified in a throwaway profile." }),
  record("review_1", { kind: "review", title: "Try the brief gallery", context: "Check rows at 390px.", artifact: { title: "Brief gallery", url: "https://gallery.example.test/", revision: "4" },
    options: [{ id: "done", label: "Done" }, { id: "problem", label: "Found a problem", input: { kind: "text", label: "What's wrong", required: true } }] }),
  record("surface_1", { title: "Board r7: develop or park?", context: "See the board.", artifact: { title: "Fixture board", surface: "fixture-board", revision: 7 } }),
  record("gone_1", { title: "Old board: develop or park?", context: "See the board.", artifact: { title: "Old board", surface: "withdrawn-board", revision: 2 } }),
  record("plain_1", { title: "Pick a retention window", context: "No Surface involved; see `/?surface=not-a-link` in code." }),
]
preview.fixture.surfaces = [{ id: "fixture-board", title: "Fixture board", summary: null, kind: "path", owner: "ux-feel", lane: "ux-feel", editspace: "fixture",
  updated_at: now, created_at: now, revision: 7, purpose: "deliverable", seen: false, health: { state: "ok", checked_at: now, last_ok_at: now } }]
const mini = "http://127.0.0.1:65021"
const miniRecord = record("44444444-4444-4444-8444-444444444444", { title: "Mini review", kind: "review", context: "Read /?surface=mini-report first.",
  artifact: { title: "Mini report", url: `${mini}/?surface=mini-report`, revision: "2" }, options: [{ id: "done", label: "Done" }] })
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const opened = []
await context.route("https://gallery.example.test/**", route => { opened.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<title>Gallery</title>" }) })
await context.route(`${mini}/**`, route => { opened.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<title>Mini</title>" }) })
await context.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: mini }] } }))
await context.route("**/hosts/mini/**", route => {
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: [] })
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (url.pathname === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [miniRecord], projects: [], partial: false, limit: 200 } })
  if (url.pathname === `/hosts/mini/es/api/attention/${miniRecord.id}`) return route.fulfill({ json: { record: miniRecord, events: [] } })
  if (url.pathname === "/hosts/mini/es/api/surfaces") return route.fulfill({ json: { surfaces: [] } })
  return route.fulfill({ status: 403, body: "not exposed" })
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
const card = id => page.locator(`article.home-decision[data-attention-id="${id}"]`)
const open = async id => {
  await page.goto(`${preview.url}/?item=${encodeURIComponent(`attention:fixture:${id}`)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(card(id)).toBeVisible({ timeout: 120_000 })
}
try {
  // A bare route in the request is a link; it opens the in-app reader in this window, no popup.
  await open("route_1")
  const route = card("route_1").locator(".home-request-text").getByRole("link", { name: "/?surface=fixture-board" })
  await expect(route).toHaveAttribute("href", "/?surface=fixture-board")
  await expect(card("route_1").locator(".artifact-open")).toHaveCount(0)
  await route.click()
  await expect(page).toHaveURL(`${preview.url}/?surface=fixture-board`)
  await expect(page.locator(".desk-surface h2")).toContainText("Fixture board")
  expect(page.context().pages().length).toBe(1)

  // A review's web artifact: one primary button beside the title, named with its revision; it opens outside the app.
  await open("review_1")
  const button = card("review_1").getByRole("link", { name: "Open Brief gallery, revision 4 (opens outside the app)" })
  await expect(button).toHaveText(/Open Brief gallery · rev 4/)
  await expect(button).toHaveAttribute("href", "https://gallery.example.test/")
  await expect(button).toHaveAttribute("target", "_blank")
  await expect(card("review_1").locator(".home-decision-title .artifact-open")).toHaveCount(1)
  await button.focus()
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.keyboard.press("Enter")])
  await popup.close()
  expect(opened).toEqual(["https://gallery.example.test/"])

  // RTL at 390px: the button stays whole on screen beside or under the title.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await button.scrollIntoViewIfNeeded()
  const box = await button.boundingBox()
  if (!box || box.x < 0 || box.x + box.width > 390) throw new Error(`clipped at 390px RTL: ${JSON.stringify(box)}`)
  await page.screenshot({ path: "/tmp/decision-artifact-rtl-390.png" })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.setViewportSize({ width: 1280, height: 900 })

  // A decision pointing at a Surface on its own dashboard: the button opens the reader in place.
  await open("surface_1")
  const surfaceButton = card("surface_1").getByRole("link", { name: "Open Fixture board, revision 7" })
  await expect(surfaceButton).toHaveAttribute("href", "/?surface=fixture-board")
  await surfaceButton.click()
  await expect(page).toHaveURL(`${preview.url}/?surface=fixture-board`)
  await expect(page.locator(".desk-surface h2")).toContainText("Fixture board")
  // A Surface its dashboard no longer lists: no button and no link, it says unavailable.
  await open("gone_1")
  await expect(card("gone_1").locator(".artifact-unavailable")).toHaveText(/Old board · rev 2 · unavailable/)
  await expect(card("gone_1").locator(".artifact-open")).toHaveCount(0)

  // No artifact and no bare route: no button and no link; a route in code stays code.
  await open("plain_1")
  await expect(card("plain_1").locator(".artifact-open")).toHaveCount(0)
  await expect(card("plain_1").locator(".home-request-text a")).toHaveCount(0)
  await expect(card("plain_1").locator(".home-request-text code")).toHaveText("/?surface=not-a-link")

  // Another host's card: its route and its artifact (on that host's own origin) open that host's Surface here.
  opened.length = 0
  await page.goto(`${preview.url}/?item=${encodeURIComponent(`mini~attention:fixture:${miniRecord.id}`)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const remote = card(miniRecord.id)
  await expect(remote).toBeVisible({ timeout: 120_000 })
  const hostItem = `/?item=${encodeURIComponent("mini~surface:mini-report")}`
  await expect(remote.locator(".home-request-text").getByRole("link", { name: "/?surface=mini-report" })).toHaveAttribute("href", hostItem)
  const remoteButton = remote.getByRole("link", { name: "Open Mini report, revision 2" })
  await expect(remoteButton).toHaveAttribute("href", hostItem)
  await expect(remoteButton).not.toHaveAttribute("target", "_blank")
  await remoteButton.click()
  await expect(page).toHaveURL(`${preview.url}${hostItem}`)
  expect(opened).toEqual([])
  expect(errors).toEqual([])
  console.log("PASS decision artifact link: request route opens the reader in place; review artifact button with revision, keyboard, 390px RTL; none without artifact or route; remote card keeps its host")
} finally {
  await browser.close()
  await preview.close()
}

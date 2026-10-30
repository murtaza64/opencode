// Agents "Activity" order from each host's Core turn time (Session.time.turn), not names and never time.updated:
// this host's and the Mac Mini's rows interleave newest turn first, with titles in reverse alphabetical order to
// recency and time.updated inverted; a row with no turn time sits last. A busy row leads, and when its turn ends it
// stays first among idle rows. The sort choice survives a reload, and the open row stays marked.
// Disposable fixture; no writes. Run from packages/es-app: node test/agents-recency.browser.mjs
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.status = "idle"
const now = Date.now()
const minute = 60_000
// time.updated runs opposite to the turn times, so an order by updated would be visibly wrong.
preview.fixture.sessionTimes.set("ses_a", { created: 1, updated: now - 1 * minute, turn: { started: now - 30 * minute, ended: now - 29 * minute } })
preview.fixture.sessionTimes.set("ses_b", { created: 1, updated: now - 9 * minute, turn: { started: now - 10 * minute, ended: now - 9 * minute } })
const aardvark = { ...session("ses_c"), title: "Aardvark local", time: { created: 1, updated: now, turn: { started: now - 50 * minute, ended: now - 49 * minute } } }
preview.fixture.workspaceSessions.push(aardvark)
const miniOrigin = "http://127.0.0.1:65033"
const miniSessions = [
  { id: "ses_z", title: "Zulu mini", directory: "/Users/mini/fixture", time: { created: 1, updated: now - 60 * minute, turn: { started: now - 6 * minute, ended: now - 5 * minute } } },
  { id: "ses_y", title: "Bravo mini", directory: "/Users/mini/fixture", time: { created: 1, updated: now } },
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const publish = (sessionID, type) => {
  for (const [response, stream] of preview.fixture.eventStreams) if (stream.path === "/global/event")
    response.write(`data: ${JSON.stringify({ directory, payload: { type: "session.status", properties: { sessionID, status: { type } } } })}\n\n`)
}
const updated = (info) => {
  for (const [response, stream] of preview.fixture.eventStreams) if (stream.path === "/global/event")
    response.write(`data: ${JSON.stringify({ directory, payload: { type: "session.updated", properties: { sessionID: info.id, info } } })}\n\n`)
}
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route(url => { const u = new URL(url); return u.origin !== preview.origin && u.origin !== miniOrigin }, route => route.abort())
await context.addInitScript(() => {
  if (!sessionStorage.getItem("agents-recency-init")) {
    sessionStorage.setItem("agents-recency-init", "1")
    localStorage.removeItem("es-app:agents-sort")
  }
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: miniOrigin }] } }))
await page.route(`${miniOrigin}/**`, route => route.fulfill({ contentType: "text/html", body: "<title>Mini</title>" }))
await page.route("**/hosts/mini/**", route => {
  const path = new URL(route.request().url()).pathname.replace(/^\/hosts\/mini/, "")
  if (path === "/oc/experimental/session") return route.fulfill({ json: miniSessions })
  if (path === "/oc/experimental/capabilities") return route.fulfill({ json: { session: { turnTime: true } } })
  if (path === "/oc/session/status") return route.fulfill({ json: {} })
  if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: "/Users/mini/fixture/.editspace" }], default: "fixture" } })
  if (path === "/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false, limit: 200 } })
  return route.fulfill({ json: [] })
})
const list = page.locator(".sidebar [role=tabpanel]")
const titles = () => list.locator(".session-entry .nav-title").allTextContents()
const ACTIVITY = ["Zulu mini", "Other session", "Composer fixture", "Aardvark local", "Bravo mini"]
try {
  await page.goto(`${preview.origin}/session/ses_b?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await page.locator(".sidebar").getByRole("tab", { name: /^Agents/ }).click()
  await expect(list.locator(".session-entry")).toHaveCount(5, { timeout: 120_000 })
  await expect.poll(titles).toEqual(ACTIVITY)
  const open = () => list.locator(".session-entry [aria-current=page] .nav-title, .session-entry[aria-current=page] .nav-title").allTextContents()
  assert.deepEqual(await open(), ["Other session"], "the open row is marked")

  // Busy leads; when its turn ends it is the newest idle row.
  await expect.poll(() => [...preview.fixture.eventStreams.values()].some(s => s.path === "/global/event")).toBe(true)
  publish("ses_c", "busy")
  await expect.poll(async () => (await titles())[0]).toBe("Aardvark local")
  const ended = { ...aardvark, time: { ...aardvark.time, turn: { started: aardvark.time.turn.started, ended: Date.now() } } }
  preview.fixture.workspaceSessions[preview.fixture.workspaceSessions.length - 1] = ended
  updated(ended)
  publish("ses_c", "idle")
  await expect.poll(titles).toEqual(["Aardvark local", "Zulu mini", "Other session", "Composer fixture", "Bravo mini"])

  // Name order survives a reload; Activity comes back the same; the open row stays marked.
  const sort = page.locator(".sidebar button[aria-label^='Sort:']")
  while (!/name/.test(await sort.getAttribute("aria-label"))) await sort.click()
  await expect.poll(titles).toEqual(["Aardvark local", "Bravo mini", "Composer fixture", "Other session", "Zulu mini"])
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.locator(".sidebar").getByRole("tab", { name: /^Agents/ }).click()
  await expect(page.locator(".sidebar button[aria-label^='Sort:']")).toHaveAttribute("aria-label", "Sort: name")
  await expect.poll(titles).toEqual(["Aardvark local", "Bravo mini", "Composer fixture", "Other session", "Zulu mini"])
  while (!/activity/.test(await sort.getAttribute("aria-label"))) await sort.click()
  await expect.poll(titles).toEqual(["Aardvark local", "Zulu mini", "Other session", "Composer fixture", "Bravo mini"])
  assert.deepEqual(await open(), ["Other session"], "the open row is still marked")
  assert.deepEqual(errors, [])
  console.log("PASS agents recency: Laptop + Mini rows newest Core turn first (not names, not time.updated), unknown last; busy leads then newest idle; Name sort persists across reload; open row kept")
} finally {
  await browser.close()
  await preview.close()
}

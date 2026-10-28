// Work view (U1a): Local and Mac Mini sessions in one sidebar list, with a third Work view host that
// never answers. Same session ID on both hosts stays two rows; Mini rows open on the Mini's own
// listener; the offline host is shown as unreachable (never empty, never merged); New session
// defaults to the Mini and only uses Local by explicit choice; pins of Mini rows are host-keyed.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
page.on("pageerror", (error) => console.log("PAGEERROR", error.message))
const mini = "http://127.0.0.1:65001"
const miniRoot = "/Users/mini/fixture"
const hostReads = { mini: 0, wing: 0 }
const hostWrites = []
const miniSessions = [
  { id: "ses_a", title: "Mini copy of a", directory: miniRoot, time: { created: 1, updated: Date.now() } },
  { id: "ses_mini", title: "Mini only", directory: `${miniRoot}/.editspace/lanes/x/repos/o/r`, time: { created: 1, updated: Date.now() - 1000 } },
  { id: "ses_elsewhere", title: "Mini other project", directory: "/Users/mini/other", time: { created: 1, updated: Date.now() } },
]
let miniDown = false
const miniMessageReads = []
const attentionQueries = []
const decision = (id, title, extra = {}) => ({ id, editspace: "fixture", revision: 1, status: "open", kind: "decision", title, options: [], delivery_state: "not-requested", created_at: Date.now() - 60_000, ...extra })
const miniDecisions = [decision("11111111-1111-4111-8111-111111111111", "Rename the ledger table?"), decision("22222222-2222-4222-8222-222222222222", "Already answered", { status: "answered" })]
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url },
  { id: "mini", label: "Mac Mini", origin: mini, default: true },
  { id: "wing", label: "Wingman", origin: "http://127.0.0.1:65002" },
] } }))
await page.route("**/hosts/mini/**", (route) => {
  hostReads.mini++
  if (!["GET", "HEAD"].includes(route.request().method())) hostWrites.push(route.request().url())
  if (miniDown) return route.abort("connectionrefused")
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: miniSessions })
  if (url.pathname === "/hosts/mini/oc/session/ses_a") return route.fulfill({ json: { ...miniSessions[0], slug: "a", projectID: "p", version: "1" } })
  if (url.pathname === "/hosts/mini/oc/session/ses_a/message") {
    miniMessageReads.push(url.search)
    return route.fulfill({ json: [{ info: { id: "msg_mini_1", sessionID: "ses_a", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
      parts: [{ id: "prt_mini_1", sessionID: "ses_a", messageID: "msg_mini_1", type: "text", text: "Hello from the Mini transcript" }] }] })
  }
  if (url.pathname === "/hosts/mini/es/api/attention") {
    attentionQueries.push(url.search)
    return route.fulfill({ json: { records: miniDecisions, projects: [{ editspace: "fixture", available: true }], partial: false } })
  }
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniRoot}/.editspace` }], default: "fixture" } })
  return route.fulfill({ status: 403, body: "not exposed" })
})
await page.route("**/hosts/wing/**", (route) => {
  hostReads.wing++
  return route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"Host unavailable"}' })
})
// Navigation to the Mini's listener is the shell's job (it opens the Mini tab); record it here.
const opened = []
await page.route(`${mini}/**`, (route) => {
  opened.push(route.request().url())
  return route.fulfill({ contentType: "text/html", body: "<title>Mini listener</title>" })
})
try {
  await page.goto(preview.url)
  const rows = page.locator(".sidebar > .session-entry .nav-item")
  // Both copies of ses_a are listed, each on its host; the Mini's other project is not in this project's view.
  await expect(page.getByRole("link", { name: /^Mini copy of a, on Mac Mini$/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /^Mini only, on Mac Mini$/ })).toBeVisible()
  await expect(page.locator(".sidebar .nav-item", { hasText: "Mini other project" })).toHaveCount(0)
  await expect(page.locator(".sidebar > .session-entry .nav-item[data-host-key='mini:ses_a']")).toHaveCount(1)
  await expect(rows.filter({ hasText: "Composer fixture" })).toHaveCount(1)
  await expect(rows.filter({ hasText: "Composer fixture" }).locator(".sr-only")).toHaveText(", on Local")
  await expect(page.locator(".host-glyph").first()).toBeVisible()
  // The host that never answers is unreachable, distinct from empty, with a retry.
  const wing = page.locator(".host-status", { hasText: "Wingman" })
  await expect(wing).toContainText(/Wingman · unreachable since/)
  await expect(page.locator(".host-status", { hasText: "Mac Mini" })).toHaveCount(0)
  // Pins of a Mini row are kept under the Mini's prefix; local pins are untouched.
  await page.getByRole("button", { name: "Pin Mini only on Mac Mini" }).click()
  await expect(page.locator(".sidebar .pinned-section .nav-item")).toHaveText([/Mini only/])
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("host:mini:es-app-sidebar-pins")))).toEqual([JSON.stringify([`${miniRoot}/.editspace/lanes/x/repos/o/r`, "ses_mini"])])
  expect(await page.evaluate(() => localStorage.getItem("es-app-sidebar-pins"))).toBeNull()
  await page.reload()
  await expect(page.locator(".sidebar .pinned-section .nav-item")).toHaveText([/Mini only/])
  // New session: the destination is shown first and defaults to the Mini; each option names its state.
  await page.getByRole("link", { name: "New session" }).first().click()
  await expect(page.getByLabel("Run on")).toHaveValue("mini")
  await expect(page.getByLabel("Run on").locator("option")).toHaveText(["Local", "Mac Mini · default", "Wingman · unreachable"])
  // The prompt is written here whatever the destination, and switching destination keeps it.
  await page.getByLabel("Message").fill("Upgrade the scoring service")
  await expect(page.locator(".new-session-draft").getByLabel("Project")).toHaveCount(0)
  await page.getByLabel("Run on").selectOption("local")
  await expect(page).toHaveURL(/\/new\?host=local$/)
  await expect(page.getByLabel("Message")).toHaveValue("Upgrade the scoring service")
  await expect(page.locator(".new-session-draft").getByLabel("Project")).toBeVisible()
  await expect(page.getByRole("button", { name: /Start on Local/ })).toBeVisible()
  await page.getByLabel("Run on").selectOption("mini")
  await expect(page.getByLabel("Message")).toHaveValue("Upgrade the scoring service")
  // Start on the Mini hands the text to the Mini's own New session page and lets go of it here.
  await page.getByRole("button", { name: /Start on Mac Mini/ }).click()
  await page.waitForURL(`${mini}/new?host=mini#draft=${encodeURIComponent("Upgrade the scoring service")}`)
  await page.goto(new URL("/new?host=local", preview.url).href)
  await expect(page.getByLabel("Message")).toHaveValue("")
  // Receiving a hand-off (a fresh page load on the receiving host): the carried text joins this
  // page's draft and leaves the URL.
  await page.goto(preview.url)
  await page.goto(new URL("/new?host=local#draft=Carried%20prompt", preview.url).href)
  await expect(page.getByLabel("Message")).toHaveValue("Carried prompt")
  await expect(page).toHaveURL(/\/new\?host=local$/)
  await page.getByLabel("Message").fill("")
  // The Mini goes away: its rows stay listed, dimmed and disabled; New session never falls back.
  miniDown = true
  await page.goto(new URL("/new", preview.url).href)
  await expect(page.getByRole("alert")).toHaveText("Mac Mini is unreachable. Choose Local or try again.")
  await expect(page.getByRole("button", { name: /Start on Mac Mini/ })).toBeDisabled()
  await expect(page.getByLabel("Run on").locator("option", { hasText: "Mac Mini" })).toHaveText("Mac Mini · default · unreachable")
  await page.getByLabel("Message").fill("Kept while the Mini is away")
  await page.getByLabel("Message").press("ControlOrMeta+Enter")
  await expect(page).toHaveURL(/\/new$/)
  await expect(page.getByLabel("Message")).toHaveValue("Kept while the Mini is away")
  await page.goto(preview.url)
  await expect(page.locator(".host-status", { hasText: "Mac Mini" })).toContainText(/unreachable since/)
  miniDown = false
  await page.locator(".host-status", { hasText: "Mac Mini" }).getByRole("button", { name: "Retry" }).click()
  await expect(page.locator(".host-status", { hasText: "Mac Mini" })).toHaveCount(0)
  // Needs you lists the Mini's open decisions after this host's, each named with its host; opening one
  // goes to the Mini's own Front desk with that record selected (answered there, with its operator).
  await page.goto(new URL("/desk", preview.url).href)
  const miniDecision = page.getByRole("link", { name: /^Rename the ledger table\?, on Mac Mini$/ })
  await expect(miniDecision).toBeVisible()
  await expect(page.locator(".desk-host-item")).toHaveCount(1)
  // Wingman never answers, so the count is already marked incomplete for it, by name.
  await expect(page.locator(".desk-queue h2 span")).toHaveAttribute("title", "Wingman: not current")
  expect(attentionQueries.at(-1)).toBe("?view=open&limit=200&es=fixture")
  await miniDecision.click()
  await expect.poll(() => opened.at(-1)).toBe(`${mini}/desk?item=${encodeURIComponent("attention:fixture:11111111-1111-4111-8111-111111111111")}`)
  // With the Mini away its decisions are not shown as none: the count is marked incomplete and names it.
  miniDown = true
  await page.goto(new URL("/desk", preview.url).href)
  await expect(page.locator(".desk-queue h2 span")).toHaveAttribute("title", "Mac Mini, Wingman: not current")
  await expect(page.locator(".desk-queue h2 span")).toHaveText(/\+$/)
  miniDown = false
  await page.goto(preview.url)
  // Opening a Mini row reads it here, read-only, through /hosts/mini; replying opens the same session on
  // the Mini's own listener. No composer exists, so no draft can be typed for the wrong host.
  await page.getByRole("link", { name: /^Mini copy of a, on Mac Mini$/ }).click()
  await expect.poll(() => new URL(page.url()).search).toBe(`?directory=${encodeURIComponent(miniRoot)}&host=mini`)
  await expect(page.locator(".host-session[data-host='mini']")).toBeVisible()
  await expect(page.locator(".host-session")).toContainText("Hello from the Mini transcript")
  await expect(page.locator(".host-session-bar")).toContainText("Read-only, on Mac Mini")
  expect(miniMessageReads.at(-1)).toBe(`?directory=${encodeURIComponent(miniRoot)}`)
  await expect(page.locator(".host-session textarea, .host-session [contenteditable]")).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Open on Mac Mini to reply" })).toHaveAttribute("href", `${mini}/session/ses_a?directory=${encodeURIComponent(miniRoot)}`)
  await page.getByRole("link", { name: "Open on Mac Mini to reply" }).click()
  await expect.poll(() => opened.at(-1)).toBe(`${mini}/session/ses_a?directory=${encodeURIComponent(miniRoot)}`)
  // The Mini is down when the page loads: its last-seen rows from this profile are listed, marked unreachable.
  await page.goto(preview.url)
  await expect(page.getByRole("link", { name: /^Mini copy of a, on Mac Mini$/ })).toBeVisible()
  miniDown = true
  await page.reload()
  await expect(page.locator(".host-status", { hasText: "Mac Mini" })).toContainText(/unreachable since/)
  await expect(page.getByRole("link", { name: /^Mini copy of a, on Mac Mini, unavailable$/ })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("host:mini:es-app-work-rows")).rows[0]).sort())).toEqual(["directory", "id", "title", "updated"])
  miniDown = false
  // This host's Core is down: it shows as unavailable (not empty), and the Mini's rows are unaffected.
  await page.route(/\/(oc|es)\//, (route) => new URL(route.request().url()).pathname.startsWith("/hosts/") ? route.fallback() : route.fulfill({ status: 503, body: "down" }))
  await page.goto(preview.url)
  await expect(page.locator(".host-status", { hasText: "Local" })).toContainText(/unavailable/, { timeout: 20000 })
  await expect(page.getByRole("link", { name: /^Mini copy of a, on Mac Mini$/ })).toBeVisible()
  // ...and this host's own last-seen rows are listed instead of an empty list.
  await expect(rows.filter({ hasText: "Composer fixture" })).toHaveCount(1)
  await page.unroute(/\/(oc|es)\//)
  // The only local write is Front desk's own operator sign-in on this host; nothing is written through /hosts/*.
  expect(preview.fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session")).toEqual([])
  expect(hostWrites).toEqual([])
  console.log(`PASS work view: two hosts listed apart (same id), offline host shown unreachable, Mini default create without fallback, draft carried to the Mini page, host-keyed pins, Mini decisions listed in Needs you and opened on the Mini desk, Mini row read-only here through /hosts/mini with reply on its own listener, reload with the Mini or Local down keeps their last-seen rows marked unavailable; host reads mini=${hostReads.mini} wing=${hostReads.wing}; zero host writes, no local mutations beyond this desk's operator sign-in`)
} finally {
  await browser.close()
  await preview.close()
}

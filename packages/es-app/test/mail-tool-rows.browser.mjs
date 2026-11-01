// Receipt-derived mail tool rows (Laptop2627). A shell call that ran `es mail send` and printed the transport's
// receipt line says who it mailed; the delivery word is the exact receipt state read on the session's own host.
// Feeds are shaped like the dashboard's: a session feed carries only receipts addressed to that session (a mail the
// session SENT comes back with none), a lane feed carries every recipient's receipts. So the row reads the sender
// lane's feed once, and follows later receipt states on mail revisions (admitted -> presented -> handled, each its
// own word; handled never becomes "started"). A receipt with no record says "reported sent · delivery not read".
// A Mac Mini session opened here reads the Mini's dashboard. A failed send or non-mail output stays a shell row.
// No timer: with no new revision the rows read nothing more. No writes.
// Run from packages/es-app: node test/mail-tool-rows.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-mail-tool-rows")
mkdirSync(shots, { recursive: true })
const mini = await createFixture()
// The listener's host routes: /hosts/mini/oc/... reaches the Mini's Core, /hosts/mini/es/... its dashboard.
const hostRoutes = {
  name: "test:hosts",
  configureServer: (server) => { server.middlewares.use((req, res, next) => {
    const match = /^\/hosts\/mini\/(?:oc|es)(\/.*)$/.exec(req.url ?? "")
    if (!match) return next()
    const upstream = httpRequest(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  }) },
}
const preview = await startToolRunsPreview(0, { iconCases: true, plugins: [hostRoutes] })
const fixture = preview.fixture
const delivery = (id, recipient, state) => ({ message_id: id, recipient, session: "ses_r", mode: "actionable", state, request_id: null, error: null, presented_at: null, handled_at: null })
const sent = (id, recipient, deliveries) => ({ id, ts: "2001-01-01T00:00:00Z", created_ms: 978307200000, from: "transcript-scan", to: recipient,
  direction: "sent", kind: "task", text: "Please review the strip.", sender_session: "ses_a", deliveries })
const states = { "ux-feel#7": "handled", "front-desk#9": "admitted" }
const base = fixture.mail
// Session feed: the mails this session sent, without other sessions' receipts. Lane feed: with them.
fixture.mail = (es, scope) => {
  const value = base(es, scope)
  const mails = Object.entries(states).map(([id, state]) => sent(id, id.split("#")[0], scope === "ses_a" ? [] : [delivery(id, id.split("#")[0], state)]))
  return scope === "ses_a" || scope === "transcript-scan" ? { ...value, messages: [...value.messages, ...mails] } : value
}
const receipt = (id, to, kind = "task") => `sent ${id} (${kind}) transcript-scan -> ${to}`
fixture.messages.push(
  preview.assistant("msg_3001", "msg_2006", [
    preview.text("q1", "Mailing ux-feel:"),
    preview.tool("m1_handled", "bash", { command: `es mail send --to ux-feel --kind task "Please review the strip." | head -1` }, receipt("ux-feel#7", "ux-feel"), { metadata: { exit: 0 } }),
    preview.text("q2", "Two mails at once:"),
    preview.tool("m2_two", "bash", { command: `es mail send --to ux-feel --kind task "a"; es mail send --to front-desk --kind task "b"` },
      `${receipt("ux-feel#7", "ux-feel")}\n${receipt("front-desk#9", "front-desk")}`, { metadata: { exit: 0 } }),
    preview.text("q2b", "A busy recipient:"),
    preview.tool("m6_later", "bash", { command: `es mail send --to front-desk --kind task "b"` }, receipt("front-desk#9", "front-desk"), { metadata: { exit: 0 } }),
    preview.text("q3", "A mail this host has no record of:"),
    preview.tool("m3_unread", "bash", { command: `es mail send --to orchestrator --kind notice "x"` }, receipt("orchestrator#55", "orchestrator", "notice"), { metadata: { exit: 0 } }),
    preview.text("q4", "A failed send, and a file that merely contains the words:"),
    preview.tool("m4_failed", "bash", { command: `es mail send --to nobody "x"` }, "error: unknown lane nobody", { status: "error" }),
    preview.text("q5", "and"),
    preview.tool("m5_cat", "bash", { command: "cat notes.txt" }, receipt("ux-feel#7", "ux-feel"), { metadata: { exit: 0 } }),
  ]),
)
// The Mini's session sent ux-feel#423; the Mini's dashboard has it presented. This host has no such mail.
mini.status = "idle"
mini.permissions = []
mini.questions = []
mini.messages = [
  { info: { id: "msg_m1", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
    parts: [{ id: "prt_m1", messageID: "msg_m1", sessionID: "ses_a", type: "text", text: "Relay the verdict" }] },
  { info: { id: "msg_m2", parentID: "msg_m1", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, time: { created: 2, completed: 3 }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ id: "mm_relay", messageID: "msg_m2", sessionID: "ses_a", type: "tool", tool: "bash", callID: "call_mm",
      state: { status: "completed", input: { command: `es mail send --to ux-feel --kind task "verdict"` }, output: "sent ux-feel#423 (task) desktop-delivery -> ux-feel",
        title: "", metadata: { exit: 0 }, time: { start: 1, end: 2 } } }] },
]
mini.mail = (es, scope) => ({ editspace: es, lane: "", messages: scope === "desktop-delivery" || scope === "ses_a"
  ? [{ ...sent("ux-feel#423", "ux-feel", scope === "ses_a" ? [] : [delivery("ux-feel#423", "ux-feel", "presented")]), from: "desktop-delivery" }] : [] })

const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(20_000)
  await page.context().route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
    { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" }] } }))
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const chip = (id) => page.locator(`.tool-chip[data-timeline-part-id="${id}"]`)
  const state = (id) => chip(id).locator(".tool-chip-state")
  const laneReads = (target) => target.calls.filter((call) => call.path === "/api/mail" && call.recipientSession === null).length
  await expect(chip("m1_handled")).toHaveCount(1, { timeout: 120_000 })

  // The session feed has the sent mail but not its receipts; the sender lane's feed supplies them.
  await expect(state("m1_handled")).toHaveText("Mail sent to ux-feel · handled")
  await expect(chip("m1_handled").locator(".tool-run-icon")).toHaveAttribute("data-mail", "sent")
  await chip("m1_handled").locator(".tool-chip-summary").hover()
  await expect(chip("m1_handled").locator(".tool-call-description")).toHaveText("ux-feel#7 task to ux-feel: ux-feel handled (acknowledged by the recipient; not proof the work started)")
  await page.screenshot({ path: join(shots, "handled.png") })
  await page.mouse.move(0, 0)
  await expect(state("m2_two")).toHaveText("Mail sent to ux-feel, front-desk · mixed states")
  // Later receipts arrive on mail revisions, each state its own word.
  await expect(state("m6_later")).toHaveText("Mail sent to front-desk · admitted")
  states["front-desk#9"] = "presented"
  fixture.emitDashboard("mail")
  await expect(state("m6_later")).toHaveText("Mail sent to front-desk · presented")
  states["front-desk#9"] = "handled"
  fixture.emitDashboard("mail")
  await expect(state("m6_later")).toHaveText("Mail sent to front-desk · handled")
  expect(await page.locator(".tool-chip-state").allTextContents()).not.toContainEqual(expect.stringMatching(/\b(started|completed)\b/))
  // No record anywhere: qualified, no state claimed.
  await expect(state("m3_unread")).toHaveText("Mail reported sent to orchestrator · delivery not read")
  // No receipt: the plain shell row.
  await expect(state("m4_failed")).toHaveText(/^failed · es mail send --to nobody/)
  await expect(chip("m4_failed").locator(".tool-run-icon")).not.toHaveAttribute("data-mail", "sent")
  await expect(state("m5_cat")).toHaveText("cat notes.txt")
  // Expanded: each mail with its delivery and its meaning.
  await chip("m2_two").locator(".tool-chip-summary").click()
  await expect(chip("m2_two").locator(".tool-chip-mail li")).toHaveText([/^ux-feel#7 task to ux-feel: ux-feel handled/, /^front-desk#9 task to front-desk: front-desk handled/])
  await page.screenshot({ path: join(shots, "expanded.png") })
  // No timer: without a new revision nothing more is read.
  const reads = fixture.calls.filter((call) => call.path === "/api/mail").length
  await page.waitForTimeout(3000)
  expect(fixture.calls.filter((call) => call.path === "/api/mail").length).toBe(reads)
  expect(laneReads(fixture)).toBeGreaterThan(0)

  // A Mac Mini session opened here: its rows read the Mini's dashboard, not this host's.
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`, { waitUntil: "domcontentloaded" })
  await expect(state("mm_relay")).toHaveText("Mail sent to ux-feel · presented", { timeout: 60_000 })
  expect(laneReads(mini)).toBeGreaterThan(0)
  await page.screenshot({ path: join(shots, "mini.png") })

  const writes = (target) => target.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session")
  expect(writes(fixture)).toEqual([])
  expect(writes(mini)).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS mail tool rows: session feed without recipient receipts -> sender lane feed read once -> exact state (handled stays handled); admitted -> presented -> handled on mail revisions; no record -> 'reported sent · delivery not read'; failed send / non-mail output stay shell rows; Mini session reads the Mini's dashboard; no timer reads; no writes; screenshots ${shots}`)
} finally {
  await preview.close()
  await mini.close?.()
  await browser.close()
}

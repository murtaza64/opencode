// Receipt-derived mail tool rows (Laptop2627). A shell call that ran `es mail send` and printed the transport's
// receipt line says who it mailed; the delivery word is the exact receipt state read on the session's own host.
// Feeds are shaped like the dashboard's: a session feed carries only receipts addressed to that session (a mail the
// session SENT comes back with none), a lane feed carries every recipient's receipts. So the row reads the sender
// lane's feed once, and follows later receipt states on mail revisions (admitted -> presented -> handled, each its
// own word; handled never becomes "started"). Without a record the row shows what `es mail send` printed at send
// time ("admitted at send"), passive and bridge-addressed mail say "recorded only", and with no evidence it says
// "delivery state not loaded", never "not read". A Mac Mini session opened here reads the Mini's dashboard; if that
// read is refused, the card says so. A failed send or non-mail output stays a shell row.
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
    preview.text("q3", "Mail this host has no record of, with and without send-time lines:"),
    preview.tool("m3_unread", "bash", { command: `es mail send --to orchestrator --kind notice "x"` }, receipt("orchestrator#55", "orchestrator", "notice"), { metadata: { exit: 0 } }),
    preview.tool("m7_atsend", "bash", { command: `es mail send --to setup --kind task "x"` },
      `${receipt("setup#123", "setup")}\n  setup: admitted (mail-setup#123-1); wake observed scheduled at 1793600000000 epoch_ms`, { metadata: { exit: 0 } }),
    preview.tool("m8_passive", "bash", { command: `es mail send --to serving-modes --kind notice "x"` },
      `${receipt("serving-modes#127", "serving-modes", "notice")}\n  serving-modes: recorded only; recipient NOT woken (passive; read with es mail check)`, { metadata: { exit: 0 } }),
    preview.tool("m9_bridge", "bash", { command: `es mail send --to rook --kind task "x"` },
      `${receipt("rook#2745", "rook")}\n  recorded only; recipient NOT woken (no runtime recipient: muted, filtered, or no owner)`, { metadata: { exit: 0 } }),
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
  // Mail ticks (DD #414): the state lives in the tick (glyph + hover/aria), never as an inline word.
  const tick = (id) => chip(id).locator(".tool-chip-summary > .msg-tick")
  const ticked = async (id, text, value, label) => {
    await expect(state(id)).toHaveText(text)
    await expect(tick(id)).toHaveAttribute("data-tick", value)
    await expect(tick(id)).toHaveAttribute("aria-label", label)
  }
  const laneReads = (target) => target.calls.filter((call) => call.path === "/api/mail" && call.recipientSession === null).length
  await expect(chip("m1_handled")).toHaveCount(1, { timeout: 120_000 })

  // The session feed has the sent mail but not its receipts; the sender lane's feed supplies them.
  await ticked("m1_handled", "Mail sent to ux-feel", "read", "Read by ux-feel")
  await expect(chip("m1_handled").locator(".tool-run-icon")).toHaveAttribute("data-mail", "sent")
  await chip("m1_handled").locator(".tool-chip-summary").hover()
  await expect(chip("m1_handled").locator(".tool-call-description")).toHaveText("ux-feel#7 task to ux-feel: ux-feel handled (acknowledged by the recipient; not proof the work started)")
  await page.screenshot({ path: join(shots, "handled.png") })
  await page.mouse.move(0, 0)
  await ticked("m2_two", "Mail sent to ux-feel, front-desk", "delivered", "ux-feel: Read by ux-feel; front-desk: In front-desk's inbox")
  // Later receipts arrive on mail revisions, each state its own word.
  await ticked("m6_later", "Mail sent to front-desk", "delivered", "In front-desk's inbox")
  states["front-desk#9"] = "presented"
  fixture.emitDashboard("mail")
  await ticked("m6_later", "Mail sent to front-desk", "read", "Read by front-desk")
  states["front-desk#9"] = "handled"
  fixture.emitDashboard("mail")
  await ticked("m6_later", "Mail sent to front-desk", "read", "Read by front-desk")
  expect(await page.locator(".tool-chip-state").allTextContents()).not.toContainEqual(expect.stringMatching(/\b(started|completed|admitted)\b/))
  // No current record: the send-time state, marked as such; passive and bridge say recorded only; no evidence: not loaded.
  await ticked("m3_unread", "Mail sent to orchestrator", "sent", "Sent · delivery receipt not available (not loaded here)")
  await ticked("m7_atsend", "Mail sent to setup", "delivered", "In setup's inbox (at send)")
  await ticked("m8_passive", "Mail sent to serving-modes", "delivered", "In serving-modes's inbox · waits for serving-modes's next turn (at send)")
  await ticked("m9_bridge", "Mail sent to rook", "delivered", "In rook's inbox · waits for rook's next turn (at send)")
  expect(await page.locator(".tool-chip-state").allTextContents()).not.toContainEqual(expect.stringMatching(/not read/))
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
  await expect(tick("mm_relay")).toHaveAttribute("data-tick", "read", { timeout: 60_000 })
  await ticked("mm_relay", "Mail sent to ux-feel", "read", "Read by ux-feel")
  expect(laneReads(mini)).toBeGreaterThan(0)
  await page.screenshot({ path: join(shots, "mini.png") })
  // A window whose listener refuses that host's mail (as es-desktop did before this fix): said plainly, never "not read".
  await page.route("**/hosts/mini/es/api/mail**", (route) => route.fulfill({ status: 403, json: { error: "not allowed" } }))
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(tick("mm_relay")).toHaveAttribute("data-tick", "sent", { timeout: 60_000 })
  await ticked("mm_relay", "Mail sent to ux-feel", "sent", "Sent · delivery receipt not available (mini's mail not readable from this window (HTTP 403))")
  await chip("mm_relay").locator(".tool-chip-summary").hover()
  await expect(chip("mm_relay").locator(".tool-call-description")).toHaveText("ux-feel#423 task to ux-feel: mini's mail not readable from this window (HTTP 403)")

  const writes = (target) => target.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path !== "/api/attention/session")
  expect(writes(fixture)).toEqual([])
  expect(writes(mini)).toEqual([])
  expect(errors).toEqual([])
  console.log(`PASS mail tool rows (ticks): session feed without recipient receipts -> sender lane feed read once -> exact state (handled stays handled); admitted -> presented -> handled on mail revisions; no record -> send-time state 'at send', passive/bridge 'recorded only', else 'delivery state not loaded' (never 'not read'); refused host read named; failed send / non-mail output stay shell rows; Mini session reads the Mini's dashboard; no timer reads; no writes; screenshots ${shots}`)
} finally {
  await preview.close()
  await mini.close?.()
  await browser.close()
}

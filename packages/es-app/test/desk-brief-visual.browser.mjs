// Question-first decision briefs on three realistic, different decisions: a read-only storage test
// (a scope/flow diagram), a reply to a person on a GitHub review (the original conversation and the
// exact reply), and a first-screen choice (a picture of each option). Each card leads with the human
// question; the producer's text folds away; a brief that cannot stand in leaves the request as written.
// Disposable fixture; brief outputs are hand-written to the contract (no model call); names paraphrased.
// Run from packages/es-app: node test/desk-brief-visual.browser.mjs [--shots DIR] [--old]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
// --old serves contract-2 briefs, for before screenshots on the previous build.
const old = process.argv.includes("--old")
const now = Date.now()
const base = { editspace: "fixture", status: "open", kind: "decision", producer_session: "ses_a", origin_session: "ses_a", source_ref: { session_id: "ses_a", directory },
  decision: null, delivery_state: "not-requested", updated_at: now, snoozed_until: null }

const probe = { ...base, id: "probe", revision: 4, created_at: now - 600_000, gate_key: "cpu:h1:v4", lane: "batch-orchestrator",
  title: "Worker CPU: authorize the read-only storage comparison? Harness ready.",
  context: "Worker CPU per message remains about 9x baseline in matched windows; the cause is unproven. The H1 harness and 12 hermetic tests are ready: pinned stage objects, 50-thread production data-access and direct-storage phases, a fresh process and temporary cache each repetition, real CPU seconds, a read-only GetObject/HeadObject allowlist, and no user payloads, configuration or secrets in output. All code-arm tests ran on the new runtime image locally; the actual old-versus-new runtime comparison has NOT run. The earlier staging plan is abandoned. Running it would push never-merged probe branches, perform one read-only manifest preflight, then six existing build-runner jobs A B C C B A (about 60-90 minutes) using the authenticated build CLI and existing managed credentials. The build node's read access to the stage bucket is unknown: the preflight stops on AccessDenied, and no role changes or fallback job are authorized. No deployment, scoring, production change, revert or fix merge. A positive result tests the storage hypothesis, not the whole-worker cure. The pending fix stays held.",
  options: [{ id: "h1-probe", label: "Authorize read-only probe branches, preflight and six build runs" }, { id: "revert-gated", label: "Prepare the revert for normal approval, CI and coordinated rollout" }, { id: "hold-investigate", label: "Keep remote jobs and production unchanged; local investigation only" }],
  recommendation: "h1-probe" }
const DRAFT = "Checked: not needed. Workbench forwards the job's environment into the container (only AWS credential vars, PATH, PYTHONPATH and index vars are filtered), so the bound LOG_DB_PASSWORD reaches the command. Same path as the PR job: the loader-log integration tests read LOG_DB_PASSWORD and passed on real RDS."
const reply = { ...base, id: "reply", revision: 1, created_at: now - 300_000, gate_key: "reply:143", lane: "loader-upgrade",
  title: "Post reply to jordan-k on etl-loader #143 (LOG_DB_PASSWORD thread)?",
  context: `#143 is merged (jordan-k APPROVED at head). jordan-k replied on the review bot's P1 thread (workbench.yaml L38, 'forward LOG_DB_PASSWORD to check-and-fix-dlq'): 'seems legit enough; check if true and fix'. Checked: not true. Workbench forwards unfiltered host env, and on the build server the bound LOG_DB_PASSWORD reaches the container: the PR build ran the real-RDS loader-log integration tests through the same wrapper and they passed. No code change. Draft reply: '${DRAFT}' Rule: I do not reply to human GitHub comments without your OK.`,
  options: [{ id: "post", label: "Post the draft reply and resolve the thread" }, { id: "skip", label: "Don't reply" }], recommendation: "post" }
const squadron = { ...base, id: "landing", revision: 2, created_at: now - 120_000, gate_key: "squadron:landing", lane: "squadron-v2",
  title: "Squadron: default landing for workspace open (start:<document id> vs overview)",
  context: "Workspace open currently resolves start:<document id> from workspace.yaml when present, else falls back to the last-opened document per user (localStorage), else the empty shell. Proposal: introduce an overview surface (pinned docs, active agents, recent changes) as the default and keep start:<document id> as an explicit override. Draft positions in the overview are unconfirmed. Need a decision before wiring the router default and migrating the 3 existing workspaces.",
  options: [{ id: "overview", label: "Overview by default; start:<document id> overrides" }, { id: "last-doc", label: "Reopen each person's last document" }, { id: "start-doc", label: "Always open the configured start document" }],
  recommendation: "overview" }
const thin = { ...base, id: "thin", revision: 1, created_at: now - 900_000, gate_key: "thin:v1", lane: "ledger",
  title: "Rename the ledger table?", context: "The table name collides with a new view. Rename it now or after the migration lands.",
  options: [{ id: "now", label: "Rename now" }, { id: "later", label: "After the migration" }], recommendation: "later" }

// Contract 4: mobile-first SVG laid out top to bottom at viewBox width 360, no width/height, text 13+ units,
// colours only from the contract's tokens. Never scaled past 400 px on desktop, so text stays below the question's size.
const svg = (body, height, width = 360) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="system-ui,sans-serif" font-size="13" style="fill:var(--fg)">${body}</svg>`
const box = (x, y, w, h, stroke, lines, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" style="fill:var(--surface);stroke:${stroke}" ${extra}/>` +
  lines.map((line, index) => `<text x="${x + 8}" y="${y + 19 + index * 16}"${index ? ' style="fill:var(--muted)"' : ' font-weight="600"'}>${line}</text>`).join("")
const arrow = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:var(--line)" stroke-width="1.5" marker-end="url(#a)"/>`
const defs = '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" style="fill:var(--line)"/></marker></defs>'
const probeVisual = svg(defs +
  box(2, 2, 356, 42, "var(--accent)", ["Stage data, read only"]) + arrow(180, 44, 180, 62) +
  box(2, 64, 356, 42, "var(--accent)", ["6 build runs: old vs new runtime"]) + arrow(180, 106, 180, 124) +
  box(2, 126, 356, 42, "var(--accent)", ["Compare CPU seconds"]) + arrow(180, 168, 180, 186) +
  box(2, 188, 174, 58, "var(--ok)", ["Can show", "if storage is the cause"]) +
  box(184, 188, 174, 58, "var(--warn)", ["Can't show", "the whole CPU fix"]) +
  box(2, 254, 356, 42, "var(--risk)", ["Not touched: deploys, production"], 'stroke-dasharray="4 3"') +
  `<text x="2" y="318" style="fill:var(--warn)">Observed: CPU per message ~9× baseline</text><text x="2" y="336" style="fill:var(--warn)">(a proxy, not a measured cause)</text>`, 344)
// Option mockups as SVG at viewBox 300×188 (16:10), text 13+ units.
const screen = (title, lines) => svg(`<rect x="1" y="1" width="298" height="160" rx="6" style="fill:var(--surface);stroke:var(--line)"/>` +
  `<text x="10" y="20" style="fill:var(--muted)">Payments workspace</text>` +
  lines.map((line, index) => `<text x="12" y="${48 + index * 22}"${line.muted ? ' style="fill:var(--muted)"' : ""}>${line.text}</text>`).join("") +
  `<text x="2" y="182" style="fill:var(--warn)">${title}</text>`, 188, 300)
const sketches = {
  overview: screen("You land on what's happening", [{ text: "Pinned: Launch plan · Runbook" }, { text: "2 agents working" }, { text: "Changed today: 4 docs" }]),
  "last-doc": screen("You land where you left off", [{ text: "Q3 pricing notes" }, { text: "…the doc you had open last…", muted: true }]),
  "start-doc": screen("Everyone lands on one page", [{ text: "Workspace README" }, { text: "the same page for everyone", muted: true }]),
}
const refs = [{ id: "C1", label: "canonical decision" }, { id: "E1", label: "assistant message in source session", messageID: "msg_e1" },
  { id: "X1", label: "review-bot (bot) on GitHub review acme/etl-loader#143 workbench.yaml:38", url: "https://github.com/acme/etl-loader/pull/143#discussion_r4317428422" },
  { id: "X2", label: "jordan-k on GitHub review acme/etl-loader#143 workbench.yaml:38", url: "https://github.com/acme/etl-loader/pull/143#discussion_r4351575820" }]
const thread = { kind: "github-review", repo: "acme/etl-loader", number: 143, path: "workbench.yaml", line: 38, url: "https://github.com/acme/etl-loader/pull/143#discussion_r4317428422",
  comments: [
    { author: "review-bot[bot]", bot: true, when: "2026-10-19T18:36:06Z", url: "https://github.com/acme/etl-loader/pull/143#discussion_r4317428422",
      body: "<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub> **Forward the loader-log database password** When the DLQ-repair job invokes this Workbench command, its environment forwards only GOOGLE_APPLICATION_CREDENTIALS; unlike the removed Compose configuration, it does not forward the host's LOG_DB_PASSWORD." },
    { author: "jordan-k", bot: false, when: "2026-10-22T17:41:16Z", url: "https://github.com/acme/etl-loader/pull/143#discussion_r4351575820", body: "seems legit enough; check if true and fix" },
  ] }

const results = old ? {
  probe: { ask: "", whyYou: "It pushes branches and runs build jobs with managed credentials.", whyNow: "Worker CPU is ~9x baseline after the runtime upgrade; the fix is held.",
    choices: [{ id: "h1-probe", outcome: "Six runs test whether storage reads are the cause", chips: ["read-only", "~60-90 min"], risk: "Tests one theory, not the whole fix" },
      { id: "revert-gated", outcome: "Revert goes through normal review and rollout", chips: [], risk: "Cause stays unknown" },
      { id: "hold-investigate", outcome: "Nothing remote runs; local digging only", chips: ["no remote jobs"], risk: "Regression lasts longer" }],
    ifWait: "", shape: { kind: "scope", included: ["Read-only object reads", "Six existing build jobs"], excluded: ["Deploys or prod writes", "Role changes"] },
    unknown: "Whether the build node can read the stage bucket.", sources: [{ label: "Harness readiness report", refs: ["E1"] }], facts: [], timeline: [], gaps: [] },
  reply: { ask: "", whyYou: "Posting replies to a human reviewer needs your OK.", whyNow: "Jordan asked to check a missing-password warning.",
    choices: [{ id: "post", outcome: "Reply explains the password already reaches the job", chips: ["no code change"], risk: "Public reply under your name" },
      { id: "skip", outcome: "Thread stays open without an answer", chips: [], risk: "Jordan's question stays unansw" }],
    ifWait: "", unknown: "Whether Jordan expects a code change anyway.", sources: [], facts: [], timeline: [], gaps: [] },
  landing: { ask: "", whyYou: "Changes what every member sees on open.", whyNow: "Router default must be wired before migrating 3 workspaces.",
    choices: [{ id: "overview", outcome: "New overview surface becomes default", chips: ["start:<document id> override"], risk: "New surface to build" },
      { id: "last-doc", outcome: "Per-user last document reopens", chips: ["localStorage"], risk: "No shared entry point" },
      { id: "start-doc", outcome: "workspace.yaml start doc always opens", chips: [], risk: "Stale start docs" }],
    ifWait: "", unknown: "Confirm draft positions before they are labelled unconfirmed.", sources: [], facts: [], timeline: [], gaps: [] },
  thin: { ask: "Rename the ledger table now or later?", whyYou: "", whyNow: "", choices: [], ifWait: "", unknown: "", sources: [], facts: [], timeline: [], gaps: [] },
} : {
  probe: {
    question: "Run a read-only test of whether storage reads cause the CPU slowdown?",
    context: "Workers use about 9× more CPU since the runtime upgrade; nobody knows why yet. The test only reads data, but it runs build jobs with team credentials, so it needs your OK.",
    visual: { title: "What the test touches and what it can tell us", svg: probeVisual, alt: "Read-only stage data feeds six build runs whose CPU is compared; it can show whether storage is the cause, not the whole fix, and touches no deploys." },
    choices: [
      { id: "h1-probe", outcome: "About 90 minutes of read-only runs answer the storage question", note: "May stop early if the build machine can't read the data" },
      { id: "revert-gated", outcome: "The upgrade is undone through the normal review, without learning why" },
      { id: "hold-investigate", outcome: "Nothing runs remotely; the slowdown continues while we dig locally" },
    ],
    sources: [{ label: "Readiness report", refs: ["E1"] }],
    facts: [{ text: "The agent reports code tests passed locally; the runtime comparison itself has not run.", refs: ["C1"] }, { text: "Six jobs A B C C B A, about 60–90 minutes; preflight stops on AccessDenied.", refs: ["C1"] }],
    gaps: ["Whether storage explains all of the CPU increase."],
  },
  reply: {
    question: "Post this reply to Jordan on the GitHub review?",
    context: "A review bot warned a password wasn't passed to a job; Jordan asked the agent to check. It isn't a problem, so the agent wants to say so publicly.",
    choices: [{ id: "post", outcome: "The reply is posted under the agent and the thread is resolved" }, { id: "skip", outcome: "No reply; Jordan's question stays open on the review" }],
    sends: DRAFT,
    sources: [{ label: "Jordan's comment", refs: ["X2"] }, { label: "The bot's warning", refs: ["X1"] }],
    facts: [{ text: "Reviewed at workbench.yaml line 38; PR #143 is already merged.", refs: ["C1"] }],
  },
  landing: {
    question: "What should someone see first when they open a workspace?",
    context: "Today it depends on settings and history, so people land in different places. This sets the default for all three existing workspaces.",
    choices: [
      { id: "overview", label: "An overview", outcome: "Pinned docs, active agents and recent changes", note: "A workspace can still choose one page instead", sketch: sketches.overview },
      { id: "last-doc", label: "Where you left off", outcome: "Each person returns to what they had open", note: "Newcomers get an empty screen", sketch: sketches["last-doc"] },
      { id: "start-doc", label: "One chosen page", outcome: "Everyone opens the same page", sketch: sketches["start-doc"] },
    ],
    facts: [{ text: "Configured today as start:<document id> in workspace.yaml, else last-opened per user.", refs: ["C1"] }],
  },
  thin: { question: "", choices: [] },
}
const message = (id, sessionID, role, text) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }) },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const records = [probe, reply, squadron, thin]
const published = structuredClone(records)
// The reply's brief job failed: the conversation must still show, with one quiet line.
let replyFails = false
const briefs = records.map(item => ({ id: `ses_brief_${item.id}`, item }))
// A brief for a later revision of the landing record, which History must never show for the earlier answer.
let laterBrief = false
const preview = await startAttentionPreview([{
  name: "visual-brief-fixture",
  configureServer(server) {
    server.middlewares.use("/es/api/frontdesk/conversation", (req, res) => {
      const record = new URL(req.url, "http://preview").searchParams.get("record")
      send(res, { threads: record === "reply" ? [thread] : [] })
    })
    server.middlewares.use("/oc/session", (req, res, next) => {
      const [, id, tail] = new URL(req.url, "http://preview").pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { time: { created: now, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, [...briefs, ...(laterBrief ? [{ id: "ses_brief_later", item: { ...squadron, revision: 5 } }] : [])].map(brief => session(brief.id, { parentID: id, metadata: { frontDesk: {
        kind: "brief", requestID: brief.id, source: `attention:fixture:${brief.item.id}`, revision: String(brief.item.revision), title: brief.item.title, refs, contract: old ? 2 : 4 } } })))
      if (id === "ses_brief_later" && tail === "message") return send(res, [message("msg_user", id, "user", "packet"),
        message("msg_reply", id, "assistant", JSON.stringify({ ...results.landing, question: "A NEWER BRIEF for a later revision" }))])
      const brief = briefs.find(item => item.id === id)
      if (brief && tail === "message") return send(res, brief.item.id === "reply" && replyFails
        ? [message("msg_user", id, "user", "packet"), { ...message("msg_reply", id, "assistant", ""), info: { ...message("msg_reply", id, "assistant", "").info, error: { name: "ProviderAuthError" } } }]
        : [message("msg_user", id, "user", "packet"), message("msg_reply", id, "assistant", JSON.stringify(results[brief.item.id]))])
      next()
    })
  },
}])
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
let failed = false
const browser = await chromium.launch({ channel: "chrome", headless: true })
const open = async (viewport, id, rtl = false, folded = false) => {
  const context = await browser.newContext({ viewport })
  // Init scripts also run in the sandboxed brief frames, which have no storage.
  await context.addInitScript(folded => { try { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "off"); localStorage.setItem("es-app:companion:work", folded ? "0" : "1") } catch {} }, folded)
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  // A cold dev server on a busy host can take minutes for the first load; later waits get headroom too.
  page.setDefaultNavigationTimeout(300_000)
  page.setDefaultTimeout(90_000)
  page.on("pageerror", error => console.error(`pageerror: ${error.message}`))
  await page.goto(`${preview.origin}/?item=${encodeURIComponent(`attention:fixture:${id}`)}`)
  if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
  return { page, card: page.locator(`[data-attention-id="${id}"]`) }
}
// Nothing in the reading path ends in a clipped word, and nothing overflows its box.
const unclipped = card => card.evaluate(element => [...element.querySelectorAll(".home-question, .home-request-line, .desk-brief-context, .home-option-outcome, .home-option-note, .desk-bubble-text, .home-sends blockquote")]
  .filter(item => item.scrollWidth > item.clientWidth + 1 || item.scrollHeight > item.clientHeight + 1 && getComputedStyle(item).overflow !== "visible").map(item => item.textContent))
const sendBottom = async card => { const box = await card.locator("button.home-primary").boundingBox(); return box && box.y + box.height }
try {
  preview.ledger.records.splice(0, preview.ledger.records.length, ...records)
  if (old) {
    for (const id of ["probe", "reply", "landing"]) {
      const { page, card } = await open({ width: 1440, height: 1000 }, id)
      await card.locator(".home-option-card").first().waitFor({ timeout: 120_000 })
      if (shots) await page.screenshot({ path: path.join(shots, `before-${id}.png`) })
    }
  } else {
    // 1. Storage probe: question, short context, the scope/flow diagram, consequence per option.
    {
       const { page, card } = await open({ width: 1440, height: 1000 }, "probe", false, true)
      await expect(card.locator("h3.home-question")).toHaveText("Run a read-only test of whether storage reads cause the CPU slowdown?", { timeout: 120_000 })
      await expect(card.locator(".home-request-line")).toContainText("Request: Worker CPU: authorize the read-only storage comparison?")
      const frame = card.locator(".desk-visual iframe")
      await expect(frame).toHaveAttribute("sandbox", "")
      // The drawing gets the app's colour tokens, so it matches es-app.
      const srcdoc = await frame.getAttribute("srcdoc")
      assert(srcdoc.includes("--fg:") && srcdoc.includes("--accent:#89b4fa") && srcdoc.includes("--surface:"), srcdoc.slice(0, 400))
      // Sized by its viewBox, at most 400 px wide; described for screen readers.
      await expect(frame).toHaveAttribute("style", /aspect-ratio: 1 \/ 0\.9555/)
      await expect(frame).toHaveAttribute("title", /Read-only stage data feeds six build runs/)
      const frameBox = await frame.boundingBox()
      assert(frameBox && frameBox.width <= 400.5 && Math.abs(frameBox.height / frameBox.width - 344 / 360) < 0.02, JSON.stringify(frameBox))
      // Never cropped: the drawing fits its frame, and its text is no larger than the question.
      const drawn = await frame.contentFrame().locator("svg").evaluate(element => ({ height: element.getBoundingClientRect().height, view: innerHeight, scroll: document.documentElement.scrollHeight }))
      assert(drawn.scroll <= drawn.view + 1, `visual cropped ${JSON.stringify(drawn)}`)
      // Rendered font size: the SVG font size scaled by the drawn width over the viewBox width.
      const sizes = await frame.contentFrame().locator("text").evaluateAll(items => items.map(item => {
        const root = item.ownerSVGElement
        return parseFloat(getComputedStyle(item).fontSize) * root.getBoundingClientRect().width / root.viewBox.baseVal.width
      }))
      const question = await card.locator("h3.home-question").evaluate(element => parseFloat(getComputedStyle(element).fontSize))
      assert(Math.max(...sizes) <= question, `visual text ${Math.max(...sizes)} > question ${question}`)
      await expect(frame.contentFrame().locator("svg")).toContainText("a proxy, not a measured cause")
      await expect(card.getByRole("radio")).toHaveCount(3)
      await expect(card.locator(".home-option-card").first()).toContainText("About 90 minutes of read-only runs answer the storage question")
      await expect(card.locator(".home-original p")).toBeHidden()
      await expect(card).not.toContainText("Why you")
      await expect(card).not.toContainText("Unknown")
      const sources = card.locator(".desk-brief-sources a")
      await expect(sources).toHaveCount(1)
      assert.match(await sources.first().getAttribute("href"), /^\/session\/ses_a\?directory=.*&message=msg_e1$/)
      assert.deepEqual(await unclipped(card), [])
      const bottom = await sendBottom(card)
      // The whole decision, through Send, fits the first screen at 1440x1000.
      assert(bottom && bottom <= 1000, `Send bottom ${bottom}`)
      if (shots) await page.screenshot({ path: path.join(shots, "after-probe.png") })
      console.log(`PROBE question + scope/flow diagram + 3 consequences; Send bottom ${Math.round(bottom)}px`)
      // A system palette switch (wal-palette/1 stylesheet) recolours the open drawing in place: same frame
      // size, no new brief request. Status colours follow only when the palette says they stay CVD-distinct.
      const frameBox0 = await frame.boundingBox()
      const jobsBefore = preview.ledger.calls.length
      const palette = (revision, safe) => page.evaluate(([revision, safe]) => {
        document.getElementById("wal-palette")?.remove()
        const style = Object.assign(document.createElement("style"), { id: "wal-palette" })
        style.textContent = `:root{--wal-revision:${revision};--wal-fg:#fefefe;--wal-surface:#101820;--wal-accent:#ff00aa;--wal-ok:#00ff00;--wal-risk:#ff0000;--wal-hl1:#123456${safe ? ";--wal-ok-risk-cvd-safe:1" : ""}}`
        document.head.append(style)
      }, [revision, safe])
      await palette("r1", false)
      await expect.poll(() => frame.getAttribute("srcdoc")).toContain("--accent:#ff00aa")
      let doc = await frame.getAttribute("srcdoc")
      assert(doc.includes("--fg:#fefefe") && doc.includes("--hl1:#123456") && doc.includes("--hl2:#ff00aa") && !doc.includes("--ok:#00ff00"), doc.slice(0, 500))
      await palette("r2", true)
      await expect.poll(() => frame.getAttribute("srcdoc")).toContain("--ok:#00ff00")
      doc = await frame.getAttribute("srcdoc")
      assert(doc.includes("--risk:#ff0000"), doc.slice(0, 500))
      await expect(frame.contentFrame().locator("svg")).toContainText("a proxy, not a measured cause")
      const frameBox1 = await frame.boundingBox()
      assert(Math.abs(frameBox1.width - frameBox0.width) < 1 && Math.abs(frameBox1.height - frameBox0.height) < 1, JSON.stringify({ frameBox0, frameBox1 }))
      await page.evaluate(() => document.getElementById("wal-palette")?.remove())
      await expect.poll(() => frame.getAttribute("srcdoc")).toContain("--accent:#89b4fa")
      assert.equal(preview.ledger.calls.length, jobsBefore, "a palette switch makes no ledger or brief requests")
      console.log("PALETTE switch recolours the open drawing in place (roles, highlights, CVD-gated status), same size, back to app colours when removed")

      // More detail on the same item: one desk message bound to the revision; draft and selection kept.
       await page.locator('[data-nav="front-desk"]').click()
       await page.getByRole("button", { name: "Start chat" }).click()
      const editor = page.locator(".desk-chat .prompt-box textarea")
      await editor.fill("draft I am still writing")
      const asks = []
      page.on("request", request => { if (request.method() === "POST" && request.url().includes("/prompt_async")) asks.push(JSON.parse(request.postData())) })
      await card.getByRole("button", { name: "More detail" }).click()
      await card.getByRole("textbox", { name: "Question for the front desk (optional)" }).fill("Why only writes?")
      await card.getByRole("button", { name: "Ask" }).click()
      await expect(card.locator(".desk-more")).toContainText("Asked in the chat.")
      assert.equal(asks.length, 1)
      assert.equal(asks[0].parts[0].text, `More detail: ${probe.title}\n\nWhy only writes?`)
      const evidence = asks[0].parts.find(part => part.metadata?.source === "es-app/front-desk-detail")
      assert(evidence?.synthetic && evidence.text.includes("attention:fixture:probe at revision 4"), evidence?.text)
      await expect(editor).toHaveValue("draft I am still writing")
      await page.waitForTimeout(1000)
      assert.equal(asks.length, 1, "no repeat send on re-render")
      console.log("MORE DETAIL one bound desk message; draft and selection kept")
    }
    // 2. Reply to a person: where and who first, the exact reply above the action.
    {
       const { page, card } = await open({ width: 1440, height: 1000 }, "reply", false, true)
      await expect(card.locator("h3.home-question")).toHaveText("Post this reply to Jordan on the GitHub review?", { timeout: 120_000 })
      const conversation = card.locator(".desk-conversation")
      await expect(conversation.locator(".desk-thread-where")).toHaveText("GitHub review · acme/etl-loader #143 · workbench.yaml:38 ↗")
      await expect(conversation.locator(".desk-thread-where")).toHaveAttribute("href", thread.url)
      const bubbles = conversation.locator(".desk-bubble")
      await expect(bubbles).toHaveCount(2)
      await expect(bubbles.first()).toHaveAttribute("data-bot", "")
      await expect(bubbles.first()).toContainText("review-bot[bot] · bot")
      await expect(bubbles.first().locator(".desk-bubble-text")).toContainText("Forward the loader-log database password")
      await expect(bubbles.nth(1)).toContainText("jordan-k")
      await expect(bubbles.nth(1).locator(".desk-bubble-text")).toHaveText("seems legit enough; check if true and fix")
      await expect(bubbles.nth(1).locator("a.desk-bubble-who")).toHaveAttribute("href", "https://github.com/acme/etl-loader/pull/143#discussion_r4351575820")
      await expect(bubbles.nth(1).locator(".desk-bubble-text a")).toHaveCount(0)
      // The note is always an open text box; no agent-speak after the recipient.
      await expect(card.getByRole("textbox", { name: /Note/ })).toBeVisible()
      await expect(card.locator(".home-answer")).not.toContainText("tool approval")
      await expect(card.locator(".home-sends blockquote")).toHaveText(DRAFT)
      await expect(card.locator(".desk-brief-sources a").first()).toHaveText("↗ GitHub · Jordan's comment")
      await expect(card.locator('a[aria-label="Open source thread"]')).toHaveText("Agent thread")
      assert.deepEqual(await unclipped(card), [])
      const bottom = await sendBottom(card)
      // The whole decision, through Send, fits the first screen at 1440x1000.
      assert(bottom && bottom <= 1000, `Send bottom ${bottom}`)
      if (shots) await page.screenshot({ path: path.join(shots, "after-reply.png") })
      console.log(`REPLY conversation (bot -> Jordan) + verbatim reply; Send bottom ${Math.round(bottom)}px`)
      // A failed brief: the conversation still shows, the request is readable, one quiet line.
      replyFails = true
      const failedView = await open({ width: 1440, height: 1000 }, "reply")
      await expect(failedView.card.locator(".desk-brief[data-part=\"lead\"]")).toContainText("The model provider refused sign-in.", { timeout: 120_000 })
      await expect(failedView.card.locator(".desk-bubble")).toHaveCount(2)
      await expect(failedView.card.locator("h3")).toHaveText(reply.title)
      await expect(failedView.card).toContainText("Draft reply:")
      await expect(failedView.card.locator(".home-warning")).toHaveCount(0)
      if (shots) await failedView.page.screenshot({ path: path.join(shots, "after-reply-brief-failed.png") })
      replyFails = false
      console.log("REPLY brief failed -> conversation + request as written, one quiet line")
    }
    // 3. First screen: a picture of each option is the option.
    {
       const { page, card } = await open({ width: 1440, height: 1000 }, "landing", false, true)
      await expect(card.locator("h3.home-question")).toHaveText("What should someone see first when they open a workspace?", { timeout: 120_000 })
      await expect(card.locator(".home-option-sketch iframe")).toHaveCount(3)
      // A plain label leads each option; the producer's exact label stays the radio's name.
      await expect(card.locator(".home-option-label").first()).toHaveText("An overview")
      await expect(card.locator(".home-option-label").filter({ hasText: "start:" })).toHaveCount(0)
      // The picture sits on top of the card, 16:10, at its drawn width (300) or the card's, whichever is smaller.
      const sketchBox = await card.locator(".home-option-sketch iframe").first().boundingBox()
      const cardBox = await card.locator(".home-option-card").first().boundingBox()
      assert(sketchBox && cardBox && sketchBox.y < cardBox.y + 20 && sketchBox.width >= Math.min(cardBox.width * 0.85, 299) && sketchBox.width <= 361 && Math.abs(sketchBox.width / sketchBox.height - 1.6) < 0.05, JSON.stringify({ sketchBox, cardBox }))
      await expect(card.locator(".home-option-sketch iframe").nth(1).contentFrame().locator("svg")).toContainText("the doc you had open last")
      await expect(card.locator(".home-option-sketch iframe").first().contentFrame().locator("svg")).toContainText("You land on what's happening")
      await expect(card.locator(".home-option-card").first()).toContainText("Pinned docs, active agents and recent changes")
      // Configuration names stay out of the reading path; the producer's labels still bind the answer.
      await expect(card.locator(".desk-brief-context")).not.toContainText("start:")
      await expect(card.locator(".home-option-outcome, .home-option-note").filter({ hasText: "start:" })).toHaveCount(0)
      await expect(card.getByRole("radio", { name: squadron.options[0].label, exact: true })).toBeVisible()
      // The request's unrelated aside (draft positions unconfirmed) stays in the folded original only.
      await expect(card.locator(".desk-brief-context, .home-option-card")).not.toContainText(["unconfirmed"])
      await card.getByRole("radio", { name: squadron.options[0].label, exact: true }).check()
      await expect(card.getByRole("button", { name: `Send ${squadron.options[0].label}`, exact: true })).toBeEnabled()
      assert.deepEqual(await unclipped(card), [])
      const bottom = await sendBottom(card)
      // The whole decision, through Send, fits the first screen at 1440x1000.
      assert(bottom && bottom <= 1000, `Send bottom ${bottom}`)
      if (shots) await page.screenshot({ path: path.join(shots, "after-landing.png") })
      console.log(`LANDING 3 option mockups; Send bottom ${Math.round(bottom)}px`)
    }
    // Answering retires the action, not the explanation: History reopens the exact brief seen when
    // answering (recorded on the answer), across reload, even after the record moved to a later revision.
    {
      const { page, card } = await open({ width: 1440, height: 1000 }, "landing")
      await expect(card.locator("h3.home-question")).toBeVisible({ timeout: 120_000 })
      const posts = []
      page.on("request", request => { if (request.method() === "POST" && request.url().includes("/commands")) posts.push(JSON.parse(request.postData())) })
      await card.getByRole("radio", { name: squadron.options[0].label, exact: true }).check()
      await card.getByRole("button", { name: `Send ${squadron.options[0].label}`, exact: true }).click()
      await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(1)
      assert.deepEqual(posts[0].brief, { job: "ses_brief_landing", revision: "2" })
      // Later the record moves on (resolved at a newer revision) and a brief exists for that revision too.
      const stored = preview.ledger.records.find(item => item.id === "landing")
      await expect.poll(() => stored.answer?.brief?.job, { timeout: 30_000 }).toBe("ses_brief_landing")
      stored.status = "resolved"
      stored.revision = 5
      laterBrief = true
      await page.reload()
      await page.locator(".desk-history summary").click()
      await page.locator(".desk-history").getByRole("button", { name: /^Resolved/ }).click()
      const row = page.locator(".desk-history .desk-item", { hasText: squadron.title })
      await expect(row.locator(".desk-item-answer")).toContainText(squadron.options[0].label)
      await row.click()
      const reopened = page.locator('[data-attention-id="landing"]')
      await expect(reopened.locator("h3.home-question")).toHaveText("What should someone see first when they open a workspace?", { timeout: 60_000 })
      await expect(reopened.locator(".home-option-sketch iframe")).toHaveCount(3)
      await expect(reopened.getByRole("radio")).toHaveCount(0)
      await expect(reopened.getByRole("button", { name: /^Send/ })).toHaveCount(0)
      await expect(reopened).toContainText(`You chose ${squadron.options[0].label}`)
      await expect(reopened).not.toContainText("A NEWER BRIEF")
      if (shots) await page.screenshot({ path: path.join(shots, "after-landing-history.png") })
      console.log("HISTORY answered brief reopened after reload at a later revision: same question + mockups, answer shown, no controls")
      // Later checks use the landing request open again, as published.
      const fresh = published.find(item => item.id === "landing")
      Object.assign(stored, structuredClone(fresh), { status: "open", answer: undefined, delivery_state: "not-requested", delivery: undefined })
      laterBrief = false
    }

    // An incomplete brief does not stand in: plain radios and the request as written.
    {
      const { card } = await open({ width: 1440, height: 1000 }, "thin")
      await expect(card.locator(".desk-brief-detail")).toHaveCount(1, { timeout: 120_000 })
      await expect(card).toContainText("The table name collides with a new view.")
      await expect(card.locator(".home-question, .home-option-card")).toHaveCount(0)
      await expect(card.getByRole("radio")).toHaveCount(2)
      console.log("HONEST incomplete brief -> plain radios + request as written")
    }
    // Companion closed at 1440: the landscape layout puts the picture at inline-start and the question,
    // options and Send together at inline-end.
    for (const id of ["probe", "landing", "reply"]) {
       const { page, card } = await open({ width: 1440, height: 1000 }, id, false, true)
       await expect(card.locator("h3.home-question")).toBeVisible({ timeout: 120_000 })
       await expect(page.locator(".desk-companion.closed")).toHaveCount(1)
       await expect(page.locator(".desk-companion")).toHaveAttribute("aria-hidden", "true")
      const question = await card.locator(".home-decision-question").boundingBox()
      const explain = await card.locator(".home-decision-explain").boundingBox()
      const act = await card.locator(".home-decision-act").boundingBox()
      // Picture options are the options: they spread across the full width instead of a side column.
      // The question heads the explainer column; the options and Send sit beside it at the same top.
       if (id === "landing") {
         const evidence = await page.locator(".desk-evidence").boundingBox()
         assert(question && act && evidence && act.width >= evidence.width - 80 && act.y > question.y, JSON.stringify({ question, act, evidence }))
       }
      else assert(question && explain && act && question.x >= explain.x && question.x + question.width <= explain.x + explain.width + 1 && act.x >= explain.x + explain.width && Math.abs(act.y - explain.y) < 2, JSON.stringify({ question, explain, act }))
      const bottom = await sendBottom(card)
      assert(bottom && bottom <= 1000, `${id} folded Send bottom ${bottom}`)
      assert.deepEqual(await unclipped(card), [])
      if (shots) await page.screenshot({ path: path.join(shots, `after-${id}-folded.png`) })
      console.log(`FOLDED ${id}: ${id === "landing" ? "picture options across the width" : "question + picture left, options + Send right"}; Send bottom ${Math.round(bottom)}px`)
    }
    // Narrow and RTL: nothing scrolls sideways, nothing is clipped.
    for (const [id, rtl] of [["landing", false], ["reply", true], ["probe", false]]) {
      const { page, card } = await open({ width: 390, height: 1600 }, id, rtl)
      await expect(card.locator("h3.home-question")).toBeVisible({ timeout: 120_000 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${id} no horizontal scroll`)
      assert.deepEqual(await unclipped(card), [])
      if (shots) await card.screenshot({ path: path.join(shots, `after-${id}-390${rtl ? "-rtl" : ""}.png`) })
    }
    console.log("NARROW 390px (one RTL): no horizontal scroll, no clipped text")
  }
  console.log("DESK BRIEF VISUAL: PASS")
} catch (error) {
  failed = true
  console.error(error)
  for (const context of browser.contexts()) for (const page of context.pages()) console.error(`--- page ${page.url()}\n${(await page.locator("main").innerText().catch(() => "")).slice(0, 1500)}`)
} finally {
  await browser.close()
  await preview.close()
  process.exit(failed ? 1 : 0)
}

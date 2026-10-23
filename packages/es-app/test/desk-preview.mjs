// Front desk fixture (dotfiles#240): the home-agents fixture plus Front desk briefs that are already
// prepared, so ready and running briefs are visible. Disposable in-memory fixture only.
// Run from packages/es-app: node test/desk-preview.mjs
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const now = Date.now()
const message = (id, sessionID, role, text, extra = {}) => ({
  info: { id, sessionID, role, time: { created: now - 60_000, ...(role === "assistant" ? { completed: now - 30_000 } : {}) }, ...(role === "assistant" ? { modelID: "fixture", providerID: "fixture", mode: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: "msg_brief_user" } : { agent: "build", model: { providerID: "fixture", modelID: "fixture" } }), ...extra },
  parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
})
// Contract 4 drawing: mobile-first SVG at viewBox width 360, colours from the contract's tokens.
const visual = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 150" font-family="system-ui,sans-serif" font-size="13">
<rect x="1" y="1" width="358" height="66" rx="8" style="fill:var(--surface);stroke:var(--ok)"/><text x="12" y="22" style="fill:var(--muted)">Small scope</text><text x="12" y="44" style="fill:var(--fg)">Home lists decisions only.</text>
<rect x="1" y="80" width="358" height="66" rx="8" style="fill:var(--surface);stroke:var(--line)"/><text x="12" y="101" style="fill:var(--muted)">Defer</text><text x="12" y="123" style="fill:var(--fg)">Home keeps today's mixed layout.</text></svg>`
const briefs = [
  {
    id: "ses_brief_scope", source: "attention:fixture:decision_1", revision: "1", title: "Choose the bounded implementation scope", state: "ready",
    refs: [{ id: "r1", label: "decision_1 context", messageID: "msg_a1" }, { id: "r2", label: "recommendation", messageID: "msg_a1" }],
    // Written to the BRIEF_SYSTEM contract: word-limited fields, no IDs, no process narration.
    result: {
      question: "Should the homepage show only what needs you?",
      context: "It changes what you see first every day.",
      choices: [{ id: "small", outcome: "Homepage lists only what needs you", note: "Agents move a click away" },
        { id: "defer", outcome: "Today's mixed layout stays" }],
      ifWait: "",
      visual: { title: "Homepage after each option", svg: visual, alt: "Small scope lists only decisions on Home; deferring keeps today's mixed layout." },
      gaps: ["No date for the follow-up pass."], sources: [{ label: "The request", refs: ["r1"] }],
      facts: [{ text: "The request asks to keep the homepage focused on what needs you.", refs: ["r1"] }, { text: "Small scope is the recommended option.", refs: ["r2"] }],
      timeline: [],
    },
  },
  { id: "ses_brief_other", source: "attention:other:other_decision", revision: "1", title: "Other project decision", state: "running", refs: [] },
]
const send = (res, body) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)) }
const session = (id, extra = {}) => ({ id, slug: id, projectID: "fixture", directory, title: id, version: "1", time: { created: now - 120_000, updated: now - 30_000 }, ...extra })
const briefPlugin = {
  name: "redesign-preview-briefs",
  configureServer(server) {
    server.middlewares.use("/oc/session", async (req, res, next) => {
      const url = new URL(req.url, "http://preview")
      const [, id, tail] = url.pathname.split("/")
      if (id?.startsWith("ses_fdbrief_") && !tail) return send(res, session(id, { title: "Front desk briefs", time: { created: now - 120_000, updated: now, archived: now } }))
      if (id?.startsWith("ses_fdbrief_") && tail === "children") return send(res, briefs.map(brief => session(brief.id, { parentID: id, title: `Brief: ${brief.title}`, metadata: { frontDesk: { kind: "brief", requestID: brief.id, source: brief.source, revision: brief.revision, title: brief.title, refs: brief.refs, contract: 4 } } })))
      const brief = briefs.find(item => item.id === id)
      if (brief && tail === "message") return send(res, brief.state === "ready"
        ? [message("msg_brief_user", brief.id, "user", "Explain this request."), message("msg_brief_reply", brief.id, "assistant", JSON.stringify(brief.result))]
        : [message("msg_brief_user", brief.id, "user", "Explain this request.")])
      if (id === "status" && !tail) {
        const base = await (await fetch(`${preview.fixture.url}/session/status${url.search}`)).json()
        return send(res, { ...base, ...Object.fromEntries(briefs.filter(item => item.state === "running").map(item => [item.id, { type: "busy" }])) })
      }
      next()
    })
  },
}
const remoteLane = { lane: "orchestrator", owner: "opencode:ses_remote", status: "active" }
const preview = await startAttentionPreview([briefPlugin, {
  name: "home-agents-preview-lanes",
  configureServer(server) {
    // Add a lane whose owner is not in the local session index.
    server.middlewares.use("/es/api/state", async (req, res) => {
      // Connect strips the mount path; keep only its query.
      const body = await (await fetch(`${preview.fixture.url}/api/state${new URL(req.url, "http://preview").search}`)).json()
      body.threads?.push({ key: "orchestrator", kind: "ticket", title: "orchestrator", sessions: [], lanes: [remoteLane], tickets: [], prs: [] })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    })
  },
}])
const fixture = preview.fixture
const permission = (id, sessionID, command) => ({ id, sessionID, permission: "bash", patterns: [command], always: [`${command.split(" ")[0]} *`], metadata: { command, description: `Synthetic ${id}` } })
fixture.strictPermissionReply = true
fixture.status = "busy"
fixture.permissions = [permission("per_tests", "ses_b", "bun test"), permission("per_status", "ses_a", "git status"), permission("per_child", "ses_child", "ls -la")]
// The fixture daemon is not directory-scoped; keep the standalone project's request list empty.
fixture.permissionsByDirectory = new Map([["/Users/me/squadron", []]])
fixture.questionsByDirectory = new Map([["/Users/me/squadron", []]])
fixture.todos = new Map([["ses_a", [
  { content: "Read the Home design", status: "completed", priority: "high" },
  { content: "Wire permission replies", status: "in_progress", priority: "high" },
  { content: "Verify in RTL", status: "pending", priority: "medium" },
]]])
fixture.laneOwners = [{ lane: "home-agents", owner: "ses_a", status: "active", activity: "Wiring the agent map", activity_at: new Date(now).toISOString(), activity_session: "ses_a" }]
fixture.handoffs = [{ lane: "home-agents", predecessor: "ses_b", successor: "ses_a" }]
const base = { projectID: "fixture", version: "1", agent: "build" }
fixture.workspaceSessions = [
  { ...base, id: "ses_child", title: "explore subagent", directory, parentID: "ses_a", time: { created: now - 5000, updated: now } },
  { ...base, id: "ses_grandchild", title: "nested reviewer", directory, parentID: "ses_child", time: { created: now - 4000, updated: now } },
  { ...base, id: "ses_squadron", title: "Squadron V2 design", directory: "/Users/me/squadron", time: { created: now - 9000, updated: now } },
  { ...base, id: "ses_stale", title: "Old standalone", directory: "/Users/me/squadron", time: { created: 1, updated: 2 } },
]
// One synthetic durable failure (#232) so the shared red dot is visible; Retry posts go to the disposable fixture's 404.
fixture.failures = [{ sessionID: "ses_squadron", directory: "/Users/me/squadron", messageID: "msg_fail", parentID: "msg_user", time: now - 1000, error: { name: "APIError", statusCode: 403, message: "Forbidden" }, retry: "available" }]
fixture.mail = (_, recipient) => ({ editspace: "fixture", lane: recipient, messages: [
  { id: "m1", ts: new Date(now - 3_600_000).toISOString(), from: "orchestrator", to: "home-agents", direction: "received", deliveries: [], kind: "task", text: "Build the agent map مرحبا" },
  { id: "m2", ts: new Date(now - 60_000).toISOString(), from: "home-agents", to: "orchestrator", direction: "sent", deliveries: [], kind: "notice", text: "Map scope report" },
] })
// Each new global stream receives one synthetic todo.updated so the "observed this turn" state is visible.
const seen = new Set()
setInterval(() => {
  for (const [response, stream] of fixture.eventStreams) {
    if (stream.path !== "/global/event" || seen.has(response)) continue
    seen.add(response)
    setTimeout(() => response.write(`data: ${JSON.stringify({ directory, payload: { type: "todo.updated", properties: { sessionID: "ses_a", todos: [
      { content: "Read the Home design", status: "completed", priority: "high" },
      { content: "Wire permission replies", status: "completed", priority: "high" },
      { content: "Verify in RTL", status: "in_progress", priority: "medium" },
    ] } } })}\n\n`), 8000)
  }
}, 1000)
console.log(`PREVIEW ${preview.url}\nSTOP kill ${process.pid}\nFront desk fixture; disposable only.`)
const close = async () => { await preview.close(); process.exit(0) }
process.on("SIGINT", close)
process.on("SIGTERM", close)

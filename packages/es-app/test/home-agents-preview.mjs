// Live synthetic preview of Home permission replies, TODO lines and the Agent map.
// Disposable in-memory fixture only; no daemon, dashboard or ledger writes.
// Run from packages/es-app: node test/home-agents-preview.mjs
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const now = Date.now()
const remoteLane = { lane: "orchestrator", owner: "opencode:ses_remote", status: "active" }
const preview = await startAttentionPreview([{
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
console.log(`PREVIEW ${preview.url}\nMAP ${preview.url}/map\nSTOP kill ${process.pid}\nSynthetic Home permission replies, TODO lines and Agent map; disposable fixture only.`)
const close = async () => { await preview.close(); process.exit(0) }
process.on("SIGINT", close)
process.on("SIGTERM", close)

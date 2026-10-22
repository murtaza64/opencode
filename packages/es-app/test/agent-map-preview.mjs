// Live synthetic preview of the Agent map (approved Fleet A design) over a
// fleet-sized disposable fixture: lanes, handoffs, subagents, cloud, mail.
// No daemon, dashboard, ledger or mail writes. Mail reads are served in memory.
// Run from packages/es-app: node test/agent-map-preview.mjs
import { pathToFileURL } from "node:url"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

export const startAgentMapPreview = async () => {
  const now = Date.now()
  const lanes = [
    { lane: "home-agents", owner: "ses_a", status: "active", activity: "Porting the approved map", activity_at: new Date(now - 60_000).toISOString(), activity_session: "ses_a" },
    { lane: "fleet-prototype", owner: "ses_fp", status: "active", activity: "Compare visualization approaches", activity_at: new Date(now - 240_000).toISOString(), activity_session: "ses_fp" },
    { lane: "session-verify", owner: "ses_sv", status: "active" },
    { lane: "ux-feel", owner: "ses_ux", status: "active", activity: "Design fidelity review", activity_at: new Date(now - 420_000).toISOString(), activity_session: "ses_ux" },
    { lane: "shell-navigation", owner: "ses_sh", status: "parked", activity: "Navigation draft awaiting review", activity_at: new Date(now - 3_600_000).toISOString(), activity_session: "ses_sh" },
    // Owner not in this session index (another machine or pruned history).
    { lane: "orchestrator", owner: "opencode:ses_remote", status: "active" },
  ]
  const statuses = { ses_a: "busy", ses_b: "idle", ses_fp: "busy", ses_sv: "idle", ses_ux: "busy", ses_ux_review: "busy", ses_sh: "idle", ses_child: "busy", ses_grandchild: "idle", ses_plan: "busy", ses_plan_audit: "idle", ses_squadron: "idle" }
  const preview = await startAttentionPreview([{
    name: "agent-map-preview-fleet",
    configureServer(server) {
      server.middlewares.use("/es/api/state", async (req, res) => {
        const body = await (await fetch(`${preview.fixture.url}/api/state${new URL(req.url, "http://preview").search}`)).json()
        body.threads?.push(...lanes.filter((lane) => lane.owner !== "ses_a").map((lane) => ({ key: lane.lane, kind: "ticket", title: lane.lane, sessions: [], lanes: [lane], tickets: [], prs: [] })))
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      })
      server.middlewares.use("/oc/session/status", (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(Object.fromEntries(Object.entries(statuses).map(([id, type]) => [id, { type }]))))
      })
    },
  }])
  const fixture = preview.fixture
  fixture.status = "busy"
  fixture.laneOwners = lanes.filter((lane) => lane.owner === "ses_a")
  fixture.handoffs = [{ lane: "home-agents", predecessor: "ses_b", successor: "ses_a" }]
  fixture.permissions = [{ id: "per_verify", sessionID: "ses_sv", permission: "bash", patterns: ["bun test"], always: [], metadata: { command: "bun test" } }]
  const base = { projectID: "fixture", version: "1", agent: "build" }
  const session = (id, title, extra = {}) => ({ ...base, id, title, directory, time: { created: now - 9000, updated: now - 1000 }, ...extra })
  fixture.workspaceSessions = [
    session("ses_fp", "Fleet prototype worker"),
    session("ses_sv", "Session verification"),
    session("ses_ux", "UX feel designer"),
    session("ses_ux_review", "design fidelity check", { parentID: "ses_ux" }),
    session("ses_sh", "Shell navigation draft"),
    session("ses_child", "explore subagent", { parentID: "ses_a" }),
    session("ses_grandchild", "nested reviewer", { parentID: "ses_child" }),
    session("ses_squadron", "Squadron V2 design", { directory: "/Users/me/squadron" }),
    session("ses_plan", "Migration plan", { directory: "/Users/me/squadron" }),
    session("ses_plan_audit", "schema audit", { directory: "/Users/me/squadron", parentID: "ses_plan" }),
  ]
  fixture.todos = new Map([["ses_a", [
    { content: "Read the approved prototype", status: "completed", priority: "high" },
    { content: "Draw the project network", status: "in_progress", priority: "high" },
    { content: "Verify in RTL", status: "pending", priority: "medium" },
  ]]])
  fixture.failures = [{ sessionID: "ses_squadron", directory: "/Users/me/squadron", messageID: "msg_fail", parentID: "msg_user", time: now - 1000, error: { name: "APIError", statusCode: 403, message: "Forbidden" }, retry: "available" }]
  // Explicit provenance only: one delegation and first-spawn records, including
  // a spawn by a past owner (ses_b handed home-agents to ses_a) and by a human.
  fixture.laneProvenance = () => ({
    delegations: [{ lane: "home-agents", parent: "ses_remote", session: "ses_a", status: "submitted" }],
    spawned: [
      { lane: "fleet-prototype", by: "ses_remote" },
      { lane: "ux-feel", by: "ses_remote" },
      { lane: "session-verify", by: "ses_b" },
      { lane: "shell-navigation", by: "murtaza@laptop" },
    ],
  })
  const minute = 60_000
  const mail = [
    ["m1", 52, "orchestrator", "home-agents", "task", "Restore the approved network map on real relation data."],
    ["m2", 49, "orchestrator", "fleet-prototype", "task", "Point home-agents at the original A and C sources."],
    ["m3", 45, "fleet-prototype", "home-agents", "notice", "Original preview and screenshots are still available."],
    ["m4", 40, "home-agents", "ux-feel", "task", "Please review fidelity against the approved originals."],
    ["m5", 33, "ux-feel", "home-agents", "notice", "Keep project regions and the delegation tree readable."],
    ["m6", 27, "home-agents", "session-verify", "notice", "Preview artifact is not ready yet."],
    ["m7", 21, "session-verify", "orchestrator", "question", "Which viewport sizes count for the proof?"],
    ["m8", 14, "orchestrator", "ux-feel", "task", "Redo the broad UX pass after this correction."],
    ["m9", 6, "home-agents", "orchestrator", "notice", "Private preview ready for visual comparison. مرحبا"],
    ["m10", 3, "home-agents", "project", "learning", "Mail edges are drawn only for selected agents."],
  ].map(([id, ago, from, to, kind, text]) => ({ id, ts: new Date(now - ago * minute).toISOString(), from, to, kind, text, deliveries: [] }))
  fixture.mail = (_, recipient) => ({ editspace: "fixture", lane: recipient, messages: mail
    .filter((message) => message.from === recipient || message.to === recipient)
    .map((message) => ({ ...message, direction: message.from === recipient ? "sent" : "received" })) })
  return preview
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startAgentMapPreview()
  console.log(`PREVIEW ${preview.url}/map\nSTOP kill ${process.pid}\nSynthetic Agent map fleet; disposable fixture only.`)
  const close = async () => { await preview.close(); process.exit(0) }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
}

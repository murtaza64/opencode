import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"
import { pathToFileURL } from "node:url"

export const startAttentionPreview = async () => {
  const ledger = {
    status: 200, partial: false, operator: false, denyOperator: false, loseResponse: false, calls: [], workCalls: [], commands: new Map(),
    cloudStatus: 200, transcriptCalls: 0,
    cloudLanes: [{ lane: "cloud-review", owner: "wingman:fixture-task", runtime: "wingman", activity: "Reviewing the attention module", "wingman-status": "processing", "wingman-cost": "0.42", "wingman-turns": "3", "wingman-prs": "https://github.com/example/repo/pull/9", "wingman-url": "https://cloud.temporal.io/namespaces/fixture/workflows/fixture" }],
    records: [{ id: "decision_1", editspace: "fixture", revision: 1, status: "open", kind: "decision", title: "Choose the bounded implementation scope", context: "Keep the homepage focused on human choices. This synthetic record is not approval to publish.", options: [{ id: "small", label: "Small scope" }, { id: "defer", label: "Defer" }], recommendation: "small", producer_session: "ses_a", origin_session: "ses_a", gate_key: "issue:219:scope:v1", source_ref: { session_id: "ses_a", directory }, decision: null, delivery_state: "not-requested", created_at: Date.now() - 300_000, updated_at: Date.now() - 300_000, snoozed_until: null },
      { id: "other_decision", editspace: "other", revision: 1, status: "open", kind: "blocker", title: "Other project decision", context: "A second project may go offline independently.", options: [{ id: "yes", label: "Continue" }], producer_session: "ses_b", origin_session: "ses_b", gate_key: "other:gate:v1", source_ref: { session_id: "ses_b", directory }, decision: null, delivery_state: "not-requested", created_at: Date.now(), updated_at: Date.now() }],
  }
  const preview = await startPanelPreview([{
    name: "attention-ledger-disposable-fixture",
    transformIndexHtml() {
      return [{ tag: "script", children: `if (!localStorage.getItem("es-app-all-projects")) localStorage.setItem("es-app-all-projects", "true"); if (!localStorage.getItem("es-app-sidebar-pins")) localStorage.setItem("es-app-sidebar-pins", ${JSON.stringify(JSON.stringify([JSON.stringify([directory, "ses_a"]) ]))});` }]
    },
    configureServer(server) {
      server.middlewares.use("/es/api/wingman", async (req, res) => {
        const url = new URL(req.url, "http://fixture")
        if (ledger.cloudStatus !== 200) { res.writeHead(ledger.cloudStatus, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "cloud source unavailable" })); return }
        if (url.pathname === "/transcript") {
          const owner = ledger.cloudLanes.find(lane => lane.lane === url.searchParams.get("lane"))?.owner
          if (url.searchParams.get("expected_owner") !== owner) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "owner changed" })); return }
          ledger.transcriptCalls++
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ owner, status: "processing", turns_dropped: 0, turns: [{ prompt: "Review the bounded module", reply: `Synthetic cloud transcript <script>not executable</script> · ${owner}` }] }))
          return
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        res.end(JSON.stringify({ lanes: ledger.cloudLanes, error: "" }))
      })
      server.middlewares.use("/es/api/attention", async (req, res) => {
        const url = new URL(req.url, "http://fixture")
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
        ledger.calls.push({ method: req.method, path: url.pathname, body, csrf: req.headers["x-attention-csrf"] })
        const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)) }
        if (url.pathname === "/session") {
          if (req.method === "POST") {
            if (ledger.denyOperator) return json({ error: "not allowed" }, 403)
            ledger.operator = true
          }
          return json({ operator: ledger.operator })
        }
        if (ledger.status !== 200) return json({ error: "fixture unavailable" }, ledger.status)
        const command = /\/([^/]+)\/commands$/.exec(url.pathname)
        if (command) {
          if (!ledger.operator) return json({ error: "operator expired" }, 401)
          if (ledger.commands.has(body.command_id)) return json(ledger.commands.get(body.command_id))
          const record = ledger.records.find(item => item.id === command[1])
          if (record.revision !== body.expected_revision) return json({ error: "revision conflict", record }, 409)
          if (body.action === "choose") { record.status = "decided"; record.decision = { choice_id: body.choice_id } }
          if (body.action === "snooze") { record.status = "snoozed"; record.snoozed_until = body.snoozed_until }
          if (body.action === "wake") { record.status = "open"; record.snoozed_until = null }
          if (body.action === "resolve") record.status = "resolved"
          record.revision++
          record.updated_at = Date.now()
          const result = { record: structuredClone(record) }
          ledger.commands.set(body.command_id, result)
          if (ledger.loseResponse) { ledger.loseResponse = false; res.destroy(); return }
          return json(result)
        }
        const id = url.pathname.slice(1)
        if (id) return json({ record: ledger.records.find(item => item.id === id), events: [{ action: "publish", actor: "producer", at: Date.now(), revision: ledger.records.find(item => item.id === id).revision }] })
        const scope = url.searchParams.get("es")
        const projects = ["fixture", "other"].filter(name => !scope || name === scope).map(name => ({ editspace: name, available: name !== "other" || !ledger.partial, ...(name === "other" && ledger.partial ? { error: "store offline" } : {}) }))
        return json({ records: ledger.records.filter(record => (!scope || record.editspace === scope) && (!ledger.partial || record.editspace !== "other")), projects, partial: ledger.partial, limit: 200, offset: 0 })
      })
    },
  }])
  preview.fixture.permissions = [{ id: "per_home", sessionID: "ses_b", permission: "bash", patterns: ["bun test"], always: [], metadata: { command: "bun test" } }]
  preview.fixture.mail = () => ({ editspace: "fixture", lane: "fixture", messages: [{ id: "mail_preview_1", ts: Date.now() - 120_000, from: "OpenCode", to: "Reviewer", direction: "sent", deliveries: [], kind: "notice", text: "Comparing the bounded attention interface. Synthetic conversation, not a decision." }] })
  preview.fixture.currentWork = (id, dir, generate) => {
    ledger.workCalls.push({ id, directory: dir, generate })
    return { turn: { started_at: Date.now() - 100_000, elapsed_seconds: 100, status: "busy", user_messages: 1, assistant_messages: 3, tool_calls: 2, active_tools: [{ name: "read", status: "running" }], watermark: "turn-1" }, summary: { status: "ready", text: "Reviewing the attention interface", generated_at: Math.floor(Date.now() / 1000) - 20, watermark: "turn-1" } }
  }
  return { ...preview, url: preview.origin, ledger }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startAttentionPreview()
  console.log(`PREVIEW ${preview.url}\nSTOP kill ${process.pid}\nSynthetic production Home with disposable attention endpoints.`)
  const close = async () => { await preview.close(); process.exit(0) }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
}

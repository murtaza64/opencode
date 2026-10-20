import { pathToFileURL } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"

export const startMailPreview = async () => {
  const preview = await startPanelPreview()
  const fixture = preview.fixture
  const directory = `${fixture.editspaces[0].root}/lanes/lane-alpha/repos/org/repo`
  const at = Date.parse("2026-10-20T12:00:00.500Z")
  fixture.sessionTimes.set("ses_a", { created: at, updated: at + 10000 })
  const receipt = { message_id: "current", recipient: "lane-alpha", session: "ses_a", mode: "actionable", state: "handled", request_id: "fixture-request", error: null, presented_at: at + 3000, handled_at: at + 4000 }
  fixture.messages = [{
    info: { id: "fixture-user", sessionID: "ses_a", role: "user", agent: "build", time: { created: at } },
    parts: [{ id: "fixture-text", messageID: "fixture-user", sessionID: "ses_a", type: "text", text: "Private fixture only. Pre-session mail is absent from the transcript. Lane mail retains the source history. Task receipts cannot prove an execution wake." }],
  }, {
    info: { id: "fixture-promoted", sessionID: "ses_a", role: "user", agent: "build", time: { created: at + 3000 }, source: { type: "editspace-mail", id: "old-promoted", sender: "reviewer", recipient: "lane-alpha" } },
    parts: [{ id: "fixture-old-text", messageID: "fixture-promoted", sessionID: "ses_a", type: "text", text: "Old content, admitted after the session began. This must not appear in the transcript." }],
  }]
  const messages = [
    { id: "old-promoted", ts: "2026-10-19T12:00:00Z", from: "reviewer", to: "lane-alpha", direction: "received", text: "Historical source; delayed receipt does not change the send time.", deliveries: [{ ...receipt, message_id: "old-promoted" }] },
    { id: "current", ts: "2026-10-20T12:00:00Z", created_ms: at + 1, from: "reviewer", to: "lane-alpha", direction: "received", kind: "task", text: "Current source, sent in the first partial second. Admission and handling are recorded; execution wake is unknown.", deliveries: [receipt] },
    { id: "passive", ts: "2026-10-20T12:00:01Z", created_ms: at + 1000, from: "مراجعة mixed review", to: "lane-alpha", direction: "received", kind: "notice", text: "Routine FYI: no action required. This delivery did not request execution.", deliveries: [{ ...receipt, message_id: "passive", mode: "passive", state: "queued", presented_at: null, handled_at: null }] },
    ...[1, 2, 3, 4].map(index => ({ id: `loop-${index}`, ts: "2026-10-20T12:00:02Z", created_ms: at + 2000 + index, from: "orchestrator", to: `review-lane-${index}`, direction: "sent", kind: "task", sender_session: "ses_a", origin_run: "fixture-run", origin_tool_call: "fixture-loop-call", text: `Durable loop send ${index}. One call, four records; no command/stdout inference.`, deliveries: [] })),
  ]
  fixture.mail = (es, recipient) => ({ editspace: es, lane: recipient === "lane-alpha" ? recipient : "", messages: recipient === "lane-alpha" ? messages.slice(0, 3) : recipient === "ses_a" ? messages.slice(3) : [] })
  return { ...preview, url: `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}` }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startMailPreview()
  console.log(`PREVIEW ${preview.url}\nFIXTURE ${preview.fixture.url}\nSTOP kill ${process.pid}`)
  const stop = async () => { await preview.close(); process.exit(0) }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
}

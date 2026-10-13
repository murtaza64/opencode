import { startPanelPreview } from "./composer-panel-preview.mjs"

const preview = await startPanelPreview()
const lane = "lane-alpha"
const directory = `${preview.fixture.editspaces[0].root}/lanes/${lane}/repos/org/repo`
const timestamp = new Date().toISOString()
preview.fixture.laneOwners = [{ lane, owner: "ses_a" }]
preview.fixture.handoffs = [{ lane, predecessor: "ses_before", successor: "ses_a" }]
preview.fixture.subscriptions = new Map([[lane, [
  { selector: "direct", sender: "*", kind: "*", mode: "actionable" },
  { selector: "project", sender: "*", kind: "learning", mode: "passive" },
]]])
preview.fixture.messages = [{
  info: {
    id: "msg_peer", sessionID: "ses_a", role: "user", agent: "build", time: { created: Date.now() },
    source: { type: "editspace-mail", id: "lane-alpha#3", sender: "reviewer", recipient: lane },
  },
  parts: [{ id: "part_peer", messageID: "msg_peer", sessionID: "ses_a", type: "text", text: "The review is ready for your decision." }],
}]
preview.fixture.mail = (es, recipient) => ({ editspace: es, lane: recipient, messages: recipient === lane ? [
  { id: "lane-alpha#1", ts: timestamp, from: lane, to: "reviewer", direction: "sent", text: "Please review the proposed change.", deliveries: [
    { message_id: "lane-alpha#1", recipient: "reviewer", session: "ses_reviewer", mode: "actionable", state: "admitted", request_id: "msg_demo_1", error: null, presented_at: null, handled_at: null },
  ] },
  { id: "lane-alpha#2", ts: timestamp, from: "reviewer", to: lane, direction: "received", kind: "answer", text: "One issue to resolve before handoff.", deliveries: [
    { message_id: "lane-alpha#2", recipient: lane, session: "ses_a", mode: "actionable", state: "presented", request_id: "msg_demo_2", error: null, presented_at: timestamp, handled_at: null },
  ] },
  { id: "lane-alpha#3", ts: timestamp, from: "reviewer", to: lane, direction: "received", kind: "learning", text: "The review is ready for your decision.", deliveries: [
    { message_id: "lane-alpha#3", recipient: lane, session: "ses_a", mode: "actionable", state: "handled", request_id: "msg_demo_3", error: null, presented_at: timestamp, handled_at: timestamp },
  ] },
] : [] })

console.log(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
const close = () => void preview.close().then(() => process.exit(0))
process.on("SIGINT", close)
process.on("SIGTERM", close)
await new Promise(() => {})

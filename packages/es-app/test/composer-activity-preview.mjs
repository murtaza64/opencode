import { pathToFileURL } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"

export const startActivityPreview = async () => {
  const preview = await startPanelPreview()
  const fixture = preview.fixture
  const lane = "lane-alpha"
  const directory = `${fixture.editspaces[0].root}/lanes/${lane}/repos/org/repo`
  const source = { type: "editspace-mail", id: "peer-mail", sender: "reviewer", recipient: lane }
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  fixture.receipts = [
    { requestID: "human-queue", sessionID: "ses_a", delivery: "queue", text: "Human draft mentions editspace-mail; keep my screenshot", agent: "build", admittedSeq: 1, timeCreated: 1, state: "pending",
      images: [{ type: "file", mime: "image/png", url: png, filename: "shot.png" }] },
    { requestID: "human-steer", sessionID: "ses_a", delivery: "steer", text: "Human steering", source: { type: "human" }, agent: "build", admittedSeq: 2, timeCreated: 2, state: "pending" },
    { requestID: "peer-queue", sessionID: "ses_a", delivery: "queue", text: "Peer queued notice", source, agent: "build", admittedSeq: 3, timeCreated: 3, state: "pending" },
    { requestID: "peer-steer", sessionID: "ses_a", delivery: "steer", text: "Peer steering notice", source: { ...source, id: "peer-steer-mail" }, agent: "build", admittedSeq: 4, timeCreated: 4, state: "pending" },
  ]
  fixture.todos = new Map([["ses_a", [
    { content: "Review src/session.ts — مراجعة", status: "in_progress", priority: "high" },
    { content: "Run fixture checks", status: "pending", priority: "medium" },
  ]]])
  fixture.mail = (es, recipient) => ({ editspace: es, lane: recipient, messages: recipient === lane ? [
    { id: source.id, ts: "2026-10-18T12:00:00Z", from: source.sender, to: lane, direction: "received", text: "Peer queued notice", deliveries: [
      { message_id: source.id, recipient: lane, session: "ses_a", mode: "queue", state: "pending", request_id: "peer-queue", error: null, presented_at: null, handled_at: null },
    ] },
    { id: "peer-steer-mail", ts: "2026-10-18T12:01:00Z", from: source.sender, to: lane, direction: "received", text: "Peer steering notice", deliveries: [
      { message_id: "peer-steer-mail", recipient: lane, session: "ses_a", mode: "steer", state: "pending", request_id: "peer-steer", error: null, presented_at: null, handled_at: null },
    ] },
  ] : [] })
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
  return preview
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startActivityPreview()
  console.log(`PREVIEW ${preview.url}\nFIXTURE ${preview.fixture.url}\nSTOP kill ${process.pid}`)
  const close = () => void preview.close().then(() => process.exit(0))
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
  await new Promise(() => {})
}

// Long-running disposable fixture preview of sourced-input styling. No real daemon.
import { startPanelPreview } from "./composer-panel-preview.mjs"

const preview = await startPanelPreview()
const base = preview.fixture.messages[0].info
const user = (id, text, source) => ({
  info: { ...base, id, ...(source ? { source } : {}) },
  parts: [{ id: `part_${id}`, messageID: id, sessionID: "ses_a", type: "text", text }],
})
preview.fixture.messages = [
  user("msg_001", "Human turn typed in es-app.", { type: "human", via: "es-app" }),
  user("msg_002", "Review is complete.\nTwo findings below.", { type: "editspace-mail", id: "project#31", sender: "reviewer", recipient: "input-provenance", kind: "answer" }),
  user("msg_003", "Continue the brief; answer project#31.\nThen park.", { type: "resume", sender: "orchestrator", senderSession: "ses_orch", in_reply_to: "project#31" }),
  user("msg_004", "Child finished: 3 files inspected.", { type: "subagent-return", sessionID: "ses_child", agent: "explore", status: "completed" }),
  user("msg_005", "You were handed this lane.", { type: "handoff", predecessor: "ses_old", lane: "input-provenance" }),
  user("msg_006", "Scheduled wake: check inbox.", { type: "heartbeat", sender: "launchd", schedule: "*/15 * * * *" }),
]
console.log(preview.url)

import { pathToFileURL } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"

// Shape of the dotfiles#241 repro: a human exchange, then three waiting mails promoted together into one turn.
export const startMailCausePreview = async () => {
  const preview = await startPanelPreview()
  const fixture = preview.fixture
  const directory = `${fixture.editspaces[0].root}/lanes/orchestrator/repos/org/repo`
  const at = Date.parse("2026-10-21T23:09:43Z")
  const minute = 60_000
  fixture.sessionTimes.set("ses_a", { created: at - 10 * minute, updated: at + 30 * minute })
  const model = { providerID: "fixture", modelID: "test" }
  const user = (id, created, text, source) => ({
    info: { id, sessionID: "ses_a", role: "user", agent: "build", model, time: { created }, ...(source ? { source } : {}) },
    parts: [{ id: `${id}-text`, messageID: id, sessionID: "ses_a", type: "text", text }],
  })
  const assistant = (id, parentID, created, text) => ({
    info: { id, parentID, sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", ...model,
      path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, completed: created + 5000 }, finish: "stop" },
    parts: [{ id: `${id}-text`, messageID: id, sessionID: "ses_a", type: "text", text }],
  })
  const source = (id, sender, extra = {}) => ({ type: "editspace-mail", id, sender, recipient: "orchestrator", kind: "task", ...extra })
  const promoted = at + 19 * minute + 26_000
  fixture.messages = [
    user("msg_human", at + 18 * minute, "How do agents become aware of decisions from Needs you?"),
    assistant("msg_reply", "msg_human", at + 18 * minute + 1000, "Written answers are delivered automatically."),
    user("msg_m417", promoted, "Start implementation of the approved front-desk direction.", source("orchestrator#417", "ses_ea34207faffeel3lksWfWq3QvU")),
    user("msg_m427", promoted + 1, "Focus on making the app feel fun and responsive.", source("orchestrator#427", "ux-feel")),
    user("msg_m428", promoted + 2, "The new-session flow should open a draft immediately.", source("orchestrator#428", "مراجعة ux-feel", { relationship: "handoff-catch-up" })),
    assistant("msg_turn", "msg_m428", promoted + 10, "All three are already adopted; one reply covers them."),
  ]
  const received = (id, created_ms, from, text) => ({ id, ts: new Date(created_ms).toISOString(), created_ms, from, to: "orchestrator",
    direction: "received", kind: "task", text, deliveries: [{ message_id: id, recipient: "orchestrator", session: "ses_a", mode: "actionable",
      state: "presented", request_id: `req-${id}`, error: null, presented_at: promoted + 10, handled_at: null,
      wake_observations: [{ outcome: "coalesced", observedAt: created_ms + 500 }] }] })
  const messages = [
    received("orchestrator#417", at, "ses_ea34207faffeel3lksWfWq3QvU", "Start implementation of the approved front-desk direction."),
    received("orchestrator#427", at + 6 * minute, "ux-feel", "Focus on making the app feel fun and responsive."),
    received("orchestrator#428", at + 9 * minute + 23_000, "مراجعة ux-feel", "The new-session flow should open a draft immediately."),
  ]
  fixture.mail = (es, lane) => ({ editspace: es, lane, messages: lane === "orchestrator" ? messages : [] })
  return { ...preview, url: `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}` }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startMailCausePreview()
  console.log(`PREVIEW ${preview.url}\nSTOP kill ${process.pid}`)
  const stop = async () => { await preview.close(); process.exit(0) }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
}

import { startPanelPreview } from "./composer-panel-preview.mjs"

const preview = await startPanelPreview()
preview.fixture.todos = new Map([
  ["ses_a", [{ content: "Verify compact activity — مراجعة src/session.ts", status: "in_progress", priority: "high" }]],
])
preview.fixture.messages[1].parts.push({
  id: "part_todo",
  messageID: "msg_2",
  sessionID: "ses_a",
  type: "tool",
  callID: "call_todo",
  tool: "todowrite",
  state: {
    status: "completed",
    input: { todos: preview.fixture.todos.get("ses_a") },
    output: "Updated",
    title: "Updated TODOs",
    time: { start: Date.now(), end: Date.now() },
    metadata: {},
  },
})
preview.fixture.laneOwners = [
  {
    lane: "fixture",
    owner: "ses_a",
    activity: "Checking activity briefs — مراجعة src/session.ts",
    activity_session: "ses_a",
    activity_at: new Date().toISOString(),
  },
]
console.log(`PREVIEW ${preview.url}\nFIXTURE ${preview.fixture.url}\nSTOP kill ${process.pid}`)
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  await preview.close()
  process.exit(0)
}
process.on("SIGINT", close)
process.on("SIGTERM", close)

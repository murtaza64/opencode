import { pathToFileURL } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

// Disposable fixture for tool size badges, compact tool runs and prompt
// navigation. Nothing here talks to a real daemon.
export const startToolRunsPreview = async (portHint = 0, options = {}) => {
  const preview = await startPanelPreview([], portHint)
  const fixture = preview.fixture
  fixture.status = "idle"
  let clock = 1_000
  const user = (id, text, extra = {}) => ({
    info: { id, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: clock++ }, ...extra.info },
    parts: extra.parts ?? [{ id: `${id}_text`, messageID: id, sessionID: "ses_a", type: "text", text }],
  })
  const assistant = (id, parentID, parts, extra = {}) => ({
    info: { id, parentID, sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
      path: { cwd: directory, root: directory }, time: { created: clock++, ...(extra.open ? {} : { completed: clock++ }) }, cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra.info },
    parts: parts.map((part) => ({ ...part, messageID: id, sessionID: "ses_a" })),
  })
  const tool = (id, name, input, output, extra = {}) => ({
    id, type: "tool", tool: name, callID: `call_${id}`,
    state: extra.status === "running" ? { status: "running", input, title: id, metadata: {}, time: { start: 10 } }
      : extra.status === "error" ? { status: "error", input, error: output, metadata: {}, time: { start: 10, end: 2_010 } }
      : { status: "completed", input, output, title: id, metadata: extra.metadata ?? {}, time: { start: 10, end: extra.end ?? 210 } },
  })
  const text = (id, value) => ({ id, type: "text", text: value })
  const path = "/workspace/مرحبا/packages/es-app/src/pages/session.tsx"
  const filler = Array.from({ length: options.filler ?? 0 }, (_, turn) => [
    user(`msg_0${String(turn).padStart(4, "0")}u`, `Earlier request ${turn}`),
    assistant(`msg_0${String(turn).padStart(4, "0")}v`, `msg_0${String(turn).padStart(4, "0")}u`, [text(`f_${turn}`, `Earlier answer ${turn}`)]),
  ]).flat()
  fixture.messages = [
    ...filler,
    user("msg_1000", "First prompt: inspect the transcript renderer."),
    assistant("msg_1001", "msg_1000", [
      text("p10_look", "Looking at the renderer first."),
      tool("p11_read", "read", { filePath: path }, "export default function SessionPage() {}"),
      tool("p12_grep", "grep", { pattern: "TranscriptMessage", path: "/workspace" }, "src/pages/session.tsx:29 needle-in-grep-output"),
    ]),
    assistant("msg_1002", "msg_1000", [
      tool("p13_glob", "glob", { pattern: "**/*.tsx" }, "a.tsx\nb.tsx"),
      tool("p14_bash", "bash", { command: "ls src", description: "List sources" }, "pages\ncomponents"),
    ]),
    assistant("msg_1003", "msg_1000", [
      text("p20_found", "Found the seams. Next, a large read and a failure."),
      tool("p21_big", "read", { filePath: "/workspace/large.log" }, "L".repeat(12_000)),
      tool("p22_fail", "bash", { command: "false" }, "Error: exit 1", { status: "error" }),
      tool("p23_a", "read", { filePath: "/workspace/a" }, "a"),
      tool("p24_b", "read", { filePath: "/workspace/b" }, "b"),
    ]),
    user("msg_1004", "", { info: { source: { type: "editspace-mail", id: "mail_77", sender: "lane-peer", recipient: "transcript-scan" } },
      parts: [{ id: "msg_1004_text", messageID: "msg_1004", sessionID: "ses_a", type: "text", text: "<editspace-mail>peer note</editspace-mail>", synthetic: true }] }),
    assistant("msg_1005", "msg_1004", [text("p30_mail", "Acknowledged the peer mail.")]),
    user("msg_1006", "Second prompt: keep going with مرحبا in the text."),
    assistant("msg_1007", "msg_1006", [
      tool("p40_ta", "read", { filePath: "/workspace/tail-a" }, "tail a"),
      tool("p41_tb", "grep", { pattern: "tail" }, "tail b"),
      tool("p42_tc", "glob", { pattern: "tail*" }, "tail c"),
      // Shell reports failure through metadata while the generic state is "completed".
      tool("p43_fail", "bash", { command: "make check" }, "boom", { metadata: { exit: 2 } }),
      tool("p44_sa", "bash", { command: "echo a" }, "a", { metadata: { exit: 0 } }),
      tool("p45_sb", "bash", { command: "echo b" }, "b", { metadata: { exit: 0 } }),
      tool("p46_sc", "bash", { command: "echo c" }, "c", { metadata: { exit: 0 } }),
    ]),
    user("msg_1008", "", { parts: [{ id: "msg_1008_text", messageID: "msg_1008", sessionID: "ses_a", type: "text", text: "Resume where you left off.", synthetic: true }] }),
    assistant("msg_1009", "msg_1008", [text("p50_resume", "Resuming.")]),
    user("msg_1010", "Third prompt: finish up."),
    assistant("msg_1011", "msg_1010", [
      text("p60_last", "Running the last checks."),
      tool("p61_la", "read", { filePath: "/workspace/live-a" }, "live a"),
      tool("p62_lb", "read", { filePath: "/workspace/live-b" }, "live b"),
      tool("p63_lc", "bash", { command: "sleep 1" }, "", { status: "running" }),
    ], { open: true }),
  ]
  // Lane-scoped URL: enables the header mail menu with lane mail and subscriptions.
  const laneDirectory = `${fixture.editspaces[0].root}/lanes/transcript-scan/repos/org/repo`
  fixture.subscriptions = new Map()
  fixture.mail = (es, lane) => ({ editspace: es, lane, messages: lane !== "transcript-scan" ? [] : Array.from({ length: 12 }, (_, index) => ({
    id: `lane-mail-${index}`, ts: "2001-01-01T00:00:00Z", from: "orchestrator", to: "transcript-scan", direction: "received", kind: "notice",
    text: `Lane mail ${index}`, deliveries: [],
  })) })
  if (options.title) fixture.sessionTitles.set("ses_a", options.title)
  return { ...preview, tool, assistant, laneUrl: `${preview.origin}/session/ses_a?directory=${encodeURIComponent(laneDirectory)}` }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startToolRunsPreview(Number(process.env.PORT ?? 0), { filler: Number(process.env.FILLER ?? 60), title: process.env.TITLE })
  console.log(`PREVIEW ${preview.url}\nLANE ${preview.laneUrl}\nFIXTURE ${preview.fixture.url}\nSTOP kill ${process.pid}`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await preview.close()
    process.exit(0)
  }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
}

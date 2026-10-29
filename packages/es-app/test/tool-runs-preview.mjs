import { pathToFileURL } from "node:url"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"
import { createMotion, createReplay, replayPlugin } from "./preview-replay.mjs"

// Disposable fixture for tool size badges, coalesced tool runs and prompt
// navigation. Nothing here talks to a real daemon.
// `options.replay`: adds the preview replay control (test/preview-replay.mjs): Replay motion / cases / all.
export const startToolRunsPreview = async (portHint = 0, options = {}) => {
  const replayState = {}
  const preview = await startPanelPreview(options.replay ? [replayPlugin(replayState)] : [], portHint)
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
  // Additive icon-chip cases (human #420 preview; ICON_CASES=1 or options.iconCases). Appended after every existing
  // message, so existing IDs and expectations are unchanged. Real tool parts in their real states, nothing special-cased.
  if (options.iconCases) fixture.messages.push(
    user("msg_2000", "Icon chip cases (preview fixture): groups, single calls, a failure, mail and a running call."),
    assistant("msg_2001", "msg_2000", [
      tool("p71_ra", "read", { filePath: "/workspace/README.md" }, "readme", { end: 90 }),
      tool("p72_rb", "grep", { pattern: "livingActivity", path: "/workspace" }, "src/appearance.ts:25", { end: 140 }),
      tool("p73_rc", "glob", { pattern: "src/**/*.css" }, "a.css\nb.css", { end: 60 }),
    ]),
    assistant("msg_2002", "msg_2000", [
      text("p74_then", "Checks, one of which failed:"),
      tool("p74_sa", "bash", { command: "bun typecheck", description: "Typecheck" }, "ok", { metadata: { exit: 0 }, end: 4_010 }),
      tool("p75_sb", "bash", { command: "bun test", description: "Unit tests" }, "2 fail", { metadata: { exit: 1 }, end: 2_010 }),
    ]),
    assistant("msg_2003", "msg_2000", [
      text("p80_single", "Single calls:"),
      tool("p81_one", "read", { filePath: path }, "export default function SessionPage() {}"),
      text("p82_then", "and an edit:"),
      tool("p83_edit", "edit", { filePath: "/workspace/src/a.ts", oldString: "a", newString: "b" }, "Edited",
        { metadata: { diff: "-a\n+b", filediff: { file: "/workspace/src/a.ts", additions: 3, deletions: 1 } } }),
      text("p84_then", "and a patch across three files:"),
      tool("p85_patch", "apply_patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: src/b.ts\n*** Add File: src/c.ts\n*** End Patch" },
        "Success. Updated the following files:", { metadata: { files: [
          { filePath: "/workspace/src/a.ts", relativePath: "src/a.ts", type: "update", additions: 4, deletions: 2 },
          { filePath: "/workspace/src/b.ts", relativePath: "src/b.ts", type: "update", additions: 1, deletions: 1 },
          { filePath: "/workspace/src/c.ts", relativePath: "src/c.ts", type: "add", additions: 7, deletions: 0 },
        ] } }),
      text("p90_fail", "A failed call:"),
      tool("p91_err", "bash", { command: "make lint" }, "Error: lint failed in src/a.ts", { status: "error" }),
      text("p91_then", "Unknown exit:"),
      tool("p92_exit", "bash", { command: "./deploy.sh" }, "", { metadata: { exit: "?" } }),
    ]),
    user("msg_2006", "", { info: { source: { type: "editspace-mail", id: "mail_icon_1", sender: "ux-feel", recipient: "transcript-scan", kind: "notice" } },
      parts: [{ id: "msg_2006_text", messageID: "msg_2006", sessionID: "ses_a", type: "text", text: "Icon chip CSS review notes." }] }),
    assistant("msg_2007", "msg_2006", [
      tool("p95_run", "bash", { command: "bun run build", description: "Build" }, "", { status: "running" }),
    ], { open: true }),
  )
  // Lane-scoped URL: enables the header mail menu with lane mail and subscriptions.
  const laneDirectory = `${fixture.editspaces[0].root}/lanes/transcript-scan/repos/org/repo`
  fixture.subscriptions = new Map()
  fixture.mail = (es, lane) => ({ editspace: es, lane, messages: lane !== "transcript-scan" ? [] : Array.from({ length: 12 }, (_, index) => ({
    id: `lane-mail-${index}`, ts: "2001-01-01T00:00:00Z", from: "orchestrator", to: "transcript-scan", direction: "received", kind: "notice",
    text: `Lane mail ${index}`, deliveries: [],
  })) })
  if (options.title) fixture.sessionTitles.set("ses_a", options.title)
  // The icon-chip cases' mail input is shown only with its mail record, as in a real session.
  if (options.iconCases) {
    const laneMail = fixture.mail
    const sent = fixture.messages.find((message) => message.info.id === "msg_2006").info.time.created
    fixture.mail = (es, recipient) => recipient !== "ses_a" ? laneMail(es, recipient) : { editspace: es, lane: "", messages: [{
      id: "mail_icon_1", ts: new Date(sent).toISOString(), created_ms: sent, from: "ux-feel", to: "transcript-scan", direction: "received",
      kind: "notice", text: "Icon chip CSS review notes.", deliveries: [] }] }
  }
  if (options.replay) {
    // Mail the motion scenario sends to this session is served with the session's other records.
    const motionMail = []
    const sessionMail = fixture.mail
    fixture.mail = (es, recipient) => {
      const base = sessionMail(es, recipient)
      return recipient === "ses_a" ? { ...base, messages: [...base.messages, ...motionMail] } : base
    }
    const motion = createMotion(fixture, { directory, addMail: (record) => motionMail.push(record) })
    const replay = createReplay(fixture, { firstCase: "msg_2000", mailRecords: [] })
    replayState.replay = (scope) => scope === "motion" ? motion() : replay(scope)
  }
  return { ...preview, tool, assistant, text, laneUrl: `${preview.origin}/session/ses_a?directory=${encodeURIComponent(laneDirectory)}` }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startToolRunsPreview(Number(process.env.PORT ?? 0), { filler: Number(process.env.FILLER ?? 60), title: process.env.TITLE,
    iconCases: process.env.ICON_CASES === "1", replay: process.env.REPLAY === "1" })
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

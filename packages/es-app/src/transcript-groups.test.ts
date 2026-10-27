import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { completedTurns, groupableTurns, messageSegments, planToolRuns, runSummary, toolOutcome } from "./transcript-groups"

const user = (id: string) => ({ id, sessionID: "ses", role: "user", time: { created: 0 } }) as unknown as Message
const assistant = (id: string, parentID = "u1", extra: Record<string, unknown> = {}) =>
  ({ id, sessionID: "ses", role: "assistant", parentID, time: { created: 0 }, ...extra }) as unknown as Message
// Engine shapes: an intermediate provider step ends with finish "tool-calls"
// and time.completed set; the final step ends with "stop" and no tool calls.
const providerStep = (id: string, parentID = "u1") => assistant(id, parentID, { finish: "tool-calls", time: { created: 0, completed: 5 } })
const finalStep = (id: string, parentID = "u1") => assistant(id, parentID, { finish: "stop", time: { created: 0, completed: 9 } })
const tool = (messageID: string, id: string, extra: {
  tool?: string; status?: string; output?: string; metadata?: Record<string, unknown>; time?: { start: number; end: number }
} = {}) => ({
  id, messageID, sessionID: "ses", type: "tool", callID: `call_${id}`, tool: extra.tool ?? "read",
  state: extra.status === "running" ? { status: "running", input: {}, time: { start: 0 } }
    : extra.status === "pending" ? { status: "pending", input: {}, raw: "" }
    : extra.status === "error" ? { status: "error", input: {}, error: "failed", metadata: extra.metadata, time: extra.time ?? { start: 0, end: 1 } }
    : { status: "completed", input: { filePath: "/a" }, output: extra.output ?? "ok", title: "", metadata: extra.metadata ?? {}, time: extra.time ?? { start: 0, end: 1 } },
}) as Part
const text = (messageID: string, id: string, value: string) => ({ id, messageID, sessionID: "ses", type: "text", text: value }) as Part
const reasoning = (messageID: string, id: string, value: string) => ({ id, messageID, sessionID: "ses", type: "reasoning", text: value, time: { start: 0 } }) as Part
const step = (messageID: string, id: string) => ({ id, messageID, sessionID: "ses", type: "step-start" }) as Part

const done = (messages: Message[], parts: Record<string, Part[]>, extra: { idle?: boolean; waiting?: string[] } = {}) =>
  [...completedTurns(messages, {
    parts: (id) => parts[id] ?? [],
    idle: extra.idle ?? false,
    waiting: (messageID, callID) => !!extra.waiting?.includes(`${messageID}/${callID}`),
  })]

const plan = (rows: Message[], parts: Record<string, Part[]>, options: { completed?: string[]; breakAfter?: (message: Message) => boolean } = {}) =>
  planToolRuns(rows.map((message) => ({ type: "transcript" as const, message })), {
    parts: (id) => parts[id] ?? [],
    visible: (part) => part.type === "tool" || ((part.type === "text" || part.type === "reasoning") && /\S/.test(part.text)),
    completed: new Set(options.completed ?? ["u1", "u2"]),
    breakAfter: options.breakAfter,
  })
const members = (result: ReturnType<typeof plan>) => [...result.runs.values()].map((run) => run.members.map((member) => member.partID))

describe("turn completion", () => {
  test("a provider step that finished with tool calls is not a completed turn", () => {
    expect(done([user("u1"), providerStep("a1")], { a1: [tool("a1", "p1"), tool("a1", "p2")] })).toEqual([])
  })

  test("the final stop step completes the turn", () => {
    expect(done([user("u1"), providerStep("a1"), finalStep("a2")], { a1: [tool("a1", "p1")], a2: [text("a2", "t", "Done")] })).toEqual(["u1"])
  })

  test("a stop step that still holds client tool calls needs continuation", () => {
    expect(done([user("u1"), finalStep("a1")], { a1: [tool("a1", "p1")] })).toEqual([])
    const provider = { ...tool("a1", "p1"), metadata: { providerExecuted: true } } as Part
    expect(done([user("u1"), finalStep("a1")], { a1: [provider] })).toEqual(["u1"])
  })

  test("an unknown or missing finish is not complete", () => {
    expect(done([user("u1"), assistant("a1", "u1", { finish: "unknown", time: { created: 0, completed: 1 } })], {})).toEqual([])
    expect(done([user("u1"), assistant("a1")], { a1: [text("a1", "t", "streaming")] })).toEqual([])
  })

  test("a provider or abort error on the last step completes the turn", () => {
    expect(done([user("u1"), providerStep("a1"), assistant("a2", "u1", { error: { name: "APIError" } })], { a1: [tool("a1", "p1")] })).toEqual(["u1"])
    expect(done([user("u1"), assistant("a1", "u1", { error: { name: "MessageAbortedError" } })],
      { a1: [tool("a1", "p1", { status: "error", metadata: { interrupted: true } })] })).toEqual(["u1"])
  })

  test("a later turn's step supersedes earlier turns, while the newest turn streams", () => {
    expect(done([user("u1"), providerStep("a1"), user("u2"), assistant("a2", "u2")],
      { a1: [tool("a1", "p1")], a2: [tool("a2", "p2", { status: "running" })] })).toEqual(["u1"])
    // A queued prompt with no answer yet does not end the running turn.
    expect(done([user("u1"), providerStep("a1"), user("u2")], { a1: [tool("a1", "p1")] })).toEqual([])
  })

  test("an idle session completes a turn whose last step finished", () => {
    expect(done([user("u1"), providerStep("a1")], { a1: [tool("a1", "p1")] }, { idle: true })).toEqual(["u1"])
    expect(done([user("u1"), assistant("a1")], { a1: [text("a1", "t", "x")] }, { idle: true })).toEqual([])
  })

  test("never complete while a call runs or a permission or question waits on it", () => {
    const error = { error: { name: "APIError" } }
    for (const status of ["pending", "running"])
      expect(done([user("u1"), assistant("a1", "u1", error)], { a1: [tool("a1", "p1", { status })] }, { idle: true })).toEqual([])
    expect(done([user("u1"), assistant("a1", "u1", error)], { a1: [tool("a1", "p1", { tool: "question" })] },
      { waiting: ["a1/call_p1"] })).toEqual([])
  })
})

describe("tool runs", () => {
  test("coalesce adjacent calls across steps of the same completed turn, keeping IDs and order", () => {
    const result = plan([assistant("a1"), assistant("a2"), assistant("a3")], {
      a1: [text("a1", "t1", "Looking"), tool("a1", "p1"), step("a1", "s1")],
      a2: [step("a2", "s2"), tool("a2", "p2"), tool("a2", "p3", { tool: "grep" })],
      a3: [tool("a3", "p4", { tool: "bash" }), text("a3", "t2", "Found it")],
    })
    expect(members(result)).toEqual([["p1", "p2", "p3", "p4"]])
    const run = [...result.runs.values()][0]!
    expect(run.key).toBe("run:a1:p1")
    expect(run.members[1]).toEqual({ messageID: "a2", partID: "p2", callID: "call_p2" })
  })

  test("two adjacent calls coalesce; a single call stays a chip", () => {
    expect(members(plan([assistant("a1")], { a1: [tool("a1", "p1"), tool("a1", "p2")] }))).toEqual([["p1", "p2"]])
    expect(members(plan([assistant("a1")], { a1: [tool("a1", "p1")] }))).toEqual([])
  })

  test("live turns never coalesce", () => {
    expect(members(plan([assistant("a1")], { a1: [tool("a1", "p1"), tool("a1", "p2"), tool("a1", "p3")] }, { completed: [] }))).toEqual([])
  })

  test("every finished tool type, size and outcome joins the run", () => {
    const calls = [
      tool("a1", "p1", { tool: "edit" }),
      tool("a1", "p2", { tool: "apply_patch" }),
      tool("a1", "p3", { tool: "task" }),
      tool("a1", "p4", { tool: "question" }),
      tool("a1", "p5", { tool: "todowrite" }),
      tool("a1", "p6", { output: "x".repeat(50_000) }),
      tool("a1", "p7", { status: "error" }),
      tool("a1", "p8", { tool: "bash", metadata: { exit: 1 } }),
      tool("a1", "p9", { tool: "bash", metadata: { exit: 0, truncated: true } }),
      tool("a1", "p10", { tool: "mcp_unknown" }),
    ]
    expect(members(plan([assistant("a1")], { a1: calls }))).toEqual([calls.map((call) => call.id)])
  })

  test("a run does not split however many calls it holds", () => {
    const calls = Array.from({ length: 250 }, (_, index) => tool("a1", `p${String(index).padStart(3, "0")}`))
    expect(members(plan([assistant("a1")], { a1: calls })).map((run) => run.length)).toEqual([250])
  })

  test("break at prose, reasoning and unfinished calls", () => {
    const parts = (breaker: Part) => ({ a1: [tool("a1", "p1"), tool("a1", "p2"), breaker, tool("a1", "p3"), tool("a1", "p4")] })
    for (const breaker of [text("a1", "b", "prose"), reasoning("a1", "b", "thinking"), tool("a1", "b", { status: "running" })])
      expect(members(plan([assistant("a1")], parts(breaker)))).toEqual([["p1", "p2"], ["p3", "p4"]])
  })

  test("whitespace text and hidden parts do not break a run", () => {
    expect(members(plan([assistant("a1")], { a1: [tool("a1", "p1"), text("a1", "w", " \n"), step("a1", "s"), tool("a1", "p2")] })))
      .toEqual([["p1", "p2"]])
  })

  test("break at user and mail rows, new turns, provider errors and turn footers", () => {
    const parts = { a1: [tool("a1", "p1"), tool("a1", "p2")], a2: [tool("a2", "p3"), tool("a2", "p4")] }
    const pairs = [["p1", "p2"], ["p3", "p4"]]
    expect(members(plan([assistant("a1"), user("u2"), assistant("a2")], parts))).toEqual(pairs)
    // A hidden user row (such as mail outside this session's interval) still starts a new turn.
    expect(members(plan([assistant("a1", "u1"), assistant("a2", "u2")], parts))).toEqual(pairs)
    expect(members(plan([assistant("a1", "u1", { error: { name: "APIError" } }), assistant("a2")], parts))).toEqual(pairs)
    expect(members(plan([assistant("a1"), assistant("a2")], parts, { breakAfter: (message) => message.id === "a1" }))).toEqual(pairs)
    const mail = planToolRuns([{ type: "transcript", message: assistant("a1") }, { type: "mail" }, { type: "transcript", message: assistant("a2") }],
      { parts: (id) => parts[id as keyof typeof parts] ?? [], visible: () => true, completed: new Set(["u1"]) })
    expect(members(mail)).toEqual(pairs)
    expect(members(plan([assistant("a1"), assistant("a2")], parts))).toEqual([["p1", "p2", "p3", "p4"]])
  })

  test("segments place each run at its first member and drop absorbed members", () => {
    const parts = {
      a1: [text("a1", "t1", "Looking"), tool("a1", "p1"), tool("a1", "p2")],
      a2: [tool("a2", "p3"), text("a2", "t2", "Done")],
    }
    const result = plan([assistant("a1"), assistant("a2")], parts)
    expect(messageSegments(parts.a1, result)).toEqual([{ kind: "parts", parts: [parts.a1[0]!] }, { kind: "run", key: "run:a1:p1" }])
    expect(messageSegments(parts.a2, result)).toEqual([{ kind: "parts", parts: [parts.a2[1]!] }])
  })
})

describe("run summary", () => {
  const tools = (...parts: Part[]) => parts as ToolPart[]

  test("names and counts each tool in first-seen order", () => {
    expect(runSummary(tools(tool("a", "1"), tool("a", "2", { tool: "bash" }), tool("a", "3"))).tools).toBe("read ×2 · bash")
  })

  test("wall span covers first start to last end, not the sum of parallel calls", () => {
    const summary = runSummary(tools(
      tool("a", "1", { time: { start: 1_000, end: 11_000 } }),
      tool("a", "2", { time: { start: 2_000, end: 12_000 } }),
      tool("a", "3", { time: { start: 3_000, end: 13_000 } }),
    ))
    expect(summary.span).toBe("12s")
  })

  test("counts failures, nonzero exits and interruptions", () => {
    const summary = runSummary(tools(
      tool("a", "1"),
      tool("a", "2", { status: "error" }),
      tool("a", "3", { tool: "bash", metadata: { exit: 2 } }),
      tool("a", "4", { status: "error", metadata: { interrupted: true } }),
    ))
    expect(summary.notes).toEqual(["2 failed", "1 interrupted"])
  })

  test("all-successful runs carry no notes", () => {
    expect(runSummary(tools(tool("a", "1"), tool("a", "2"))).notes).toEqual([])
  })

  test("a null or invalid exit code is reported as unknown, not failed", () => {
    const summary = runSummary(tools(
      tool("a", "1", { tool: "bash", metadata: { exit: null } }),
      tool("a", "2", { tool: "bash", metadata: { exit: "killed" } }),
      tool("a", "3", { tool: "bash", metadata: { exit: 0 } }),
    ))
    expect(summary.notes).toEqual(["2 exit unknown"])
  })

  test("partial timing makes the span a labelled lower bound", () => {
    const untimed = { ...tool("a", "2"), state: { ...(tool("a", "2") as ToolPart).state, time: { start: 0 } } } as Part
    const summary = runSummary(tools(tool("a", "1", { time: { start: 1_000, end: 4_000 } }), untimed))
    expect(summary.span).toBe("≥3.0s")
    expect(summary.spanLabel).toBe("At least 3.0s wall clock: first start to last end of 1 timed calls; 1 without timing")
    expect(summary.notes).toEqual(["1 untimed"])
  })

  test("outcome reads metadata errors as failures", () => {
    expect(toolOutcome(tool("a", "1", { metadata: { error: "denied" } }) as ToolPart)).toBe("failed")
    expect(toolOutcome(tool("a", "1", { tool: "bash", metadata: { exit: 0 } }) as ToolPart)).toBe("ok")
  })
})

describe("groupableTurns", () => {
  const done = new Set(["msg_010", "msg_020", "msg_030"])
  test("at idle every finished turn may group", () => {
    expect([...groupableTurns(done)]).toEqual(["msg_010", "msg_020", "msg_030"])
  })
  test("during a run only turns finished before it began may group", () => {
    // msg_020 finished mid-run (a steer ended its turn): it stays ungrouped until idle.
    expect([...groupableTurns(done, { before: new Set(["msg_010"]), oldest: "msg_010" })]).toEqual(["msg_010"])
  })
  test("older history paged in during a run may group", () => {
    expect([...groupableTurns(new Set(["msg_001", "msg_020"]), { before: new Set(), oldest: "msg_010" })]).toEqual(["msg_001"])
  })
})

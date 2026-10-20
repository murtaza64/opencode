import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { messageSegments, planToolRuns, RUN_LIMITS } from "./transcript-groups"

const user = (id: string, source?: unknown) => ({ id, sessionID: "ses", role: "user", time: { created: 0 }, ...(source ? { source } : {}) }) as unknown as Message
const assistant = (id: string, parentID = "u1", error?: unknown) =>
  ({ id, sessionID: "ses", role: "assistant", parentID, time: { created: 0 }, ...(error ? { error } : {}) }) as unknown as Message
const tool = (messageID: string, id: string, extra: { tool?: string; status?: string; output?: string; metadata?: Record<string, unknown> } = {}) => ({
  id, messageID, sessionID: "ses", type: "tool", callID: `call_${id}`, tool: extra.tool ?? "read",
  state: extra.status === "running" ? { status: "running", input: {}, time: { start: 0 } }
    : extra.status === "error" ? { status: "error", input: {}, error: "failed", time: { start: 0, end: 1 } }
    : { status: "completed", input: { filePath: "/a" }, output: extra.output ?? "ok", title: "", metadata: extra.metadata ?? {}, time: { start: 0, end: 1 } },
}) as Part
const text = (messageID: string, id: string, value: string) => ({ id, messageID, sessionID: "ses", type: "text", text: value }) as Part
const step = (messageID: string, id: string) => ({ id, messageID, sessionID: "ses", type: "step-start" }) as Part

const plan = (rows: Message[], parts: Record<string, Part[]>, breakAfter?: (message: Message) => boolean) =>
  planToolRuns(rows.map((message) => ({ type: "transcript" as const, message })), {
    parts: (id) => parts[id] ?? [],
    visible: (part) => part.type === "tool" || (part.type === "text" && /\S/.test(part.text)),
    breakAfter,
  })
const members = (result: ReturnType<typeof plan>) => [...result.runs.values()].map((run) => run.members.map((member) => member.partID))

describe("tool runs", () => {
  test("coalesce small finished calls across assistant messages, keeping IDs and order", () => {
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

  test("need at least the minimum count", () => {
    expect(plan([assistant("a1")], { a1: [tool("a1", "p1"), tool("a1", "p2")] }).runs.size).toBe(0)
    expect(RUN_LIMITS.min).toBe(3)
  })

  test("break at prose, errors, running calls, large output and significant tools", () => {
    const parts = (breaker: Part) => ({ a1: [tool("a1", "p1"), tool("a1", "p2"), breaker, tool("a1", "p3"), tool("a1", "p4")] })
    for (const breaker of [
      text("a1", "b", "prose"),
      tool("a1", "b", { status: "error" }),
      tool("a1", "b", { status: "running" }),
      tool("a1", "b", { output: "x".repeat(3000) }),
      tool("a1", "b", { tool: "task" }),
      tool("a1", "b", { tool: "apply_patch" }),
      tool("a1", "b", { tool: "question" }),
    ]) expect(members(plan([assistant("a1")], parts(breaker)))).toEqual([])
  })

  test("short shell calls group by size, but a reported failure stays visible and splits runs", () => {
    const ok = (id: string) => tool("a1", id, { tool: "bash", metadata: { exit: 0 } })
    expect(members(plan([assistant("a1")], { a1: [ok("p1"), ok("p2"), ok("p3")] }))).toEqual([["p1", "p2", "p3"]])
    for (const metadata of [{ exit: 1 }, { exit: null }, { error: "denied" }]) {
      const failed = tool("a1", "f", { tool: "bash", metadata })
      expect(members(plan([assistant("a1")], { a1: [ok("p1"), ok("p2"), ok("p3"), failed, ok("p4"), ok("p5"), ok("p6")] })))
        .toEqual([["p1", "p2", "p3"], ["p4", "p5", "p6"]])
    }
  })

  test("capped or truncated evidence never claims a small size", () => {
    const truncated = tool("a1", "t", { tool: "bash", metadata: { exit: 0, truncated: true } })
    expect(members(plan([assistant("a1")], { a1: [tool("a1", "p1"), tool("a1", "p2"), truncated, tool("a1", "p3")] }))).toEqual([])
  })

  test("whitespace text and hidden parts do not break a run", () => {
    expect(members(plan([assistant("a1")], { a1: [tool("a1", "p1"), text("a1", "w", " \n"), step("a1", "s"), tool("a1", "p2"), tool("a1", "p3")] })))
      .toEqual([["p1", "p2", "p3"]])
  })

  test("break at user and mail rows, new turns, message errors and turn summaries", () => {
    const parts = { a1: [tool("a1", "p1"), tool("a1", "p2")], a2: [tool("a2", "p3"), tool("a2", "p4")] }
    expect(members(plan([assistant("a1"), user("u2"), assistant("a2")], parts))).toEqual([])
    // A hidden user row (such as mail outside this session's interval) still starts a new turn.
    expect(members(plan([assistant("a1", "u1"), assistant("a2", "u2")], parts))).toEqual([])
    expect(members(plan([assistant("a1"), assistant("a2", "u1", { name: "APIError" })], parts))).toEqual([])
    expect(members(plan([assistant("a1"), assistant("a2")], parts, (message) => message.id === "a1"))).toEqual([])
    const mail = planToolRuns([{ type: "transcript", message: assistant("a1") }, { type: "mail" }, { type: "transcript", message: assistant("a2") }],
      { parts: (id) => parts[id as keyof typeof parts] ?? [], visible: () => true })
    expect(mail.runs.size).toBe(0)
    expect(members(plan([assistant("a1"), assistant("a2")], parts))).toEqual([["p1", "p2", "p3", "p4"]])
  })

  test("runs are bounded in size", () => {
    const parts = Array.from({ length: RUN_LIMITS.max + 5 }, (_, index) => tool("a1", `p${index}`))
    expect(members(plan([assistant("a1")], { a1: parts })).map((run) => run.length)).toEqual([RUN_LIMITS.max, 5])
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

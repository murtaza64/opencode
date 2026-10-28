import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { diff, snapshot, type StepPart } from "./adapter"

const user = (id: string): Message => ({ id, sessionID: "ses", role: "user", time: { created: 1 } } as Message)
const assistant = (id: string): Message => ({ id, sessionID: "ses", role: "assistant", time: { created: 2 } } as Message)
const text = (id: string, messageID: string, body: string, end?: number): Part => ({ id, sessionID: "ses", messageID, type: "text", text: body, time: { start: 10, end } } as Part)
const tool = (id: string, messageID: string, status: "running" | "completed" | "error", name = "bash"): Part => ({
  id, sessionID: "ses", messageID, type: "tool", callID: id, tool: name,
  state: status === "running" ? { status, input: {}, time: { start: 20 } } : status === "completed" ? { status, input: {}, output: "", title: "", metadata: {}, time: { start: 20, end: 25 } } : { status, input: {}, error: "x", time: { start: 20, end: 25 } },
} as Part)

const build = (messages: Message[], parts: Record<string, Part[]>, status = "busy", pending: { kind: "permission" | "question"; request: { id: string } }[] = [], subagents = 0, steps: Record<string, StepPart[]> = {}) =>
  snapshot({ messages, parts: (id) => parts[id] ?? [], status, pending, subagents, steps: (id) => steps[id] ?? [] })

describe("snapshot phase", () => {
  test("busy with no parts after the user prompt is thinking", () => {
    expect(build([user("u1")], {}).phase).toBe("thinking")
  })
  test("open text part while busy is streaming", () => {
    expect(build([user("u1"), assistant("a1")], { a1: [text("t1", "a1", "hel")] }).phase).toBe("streaming")
  })
  test("running tool beats streaming", () => {
    expect(build([user("u1"), assistant("a1")], { a1: [text("t1", "a1", "hel"), tool("c1", "a1", "running")] }).phase).toBe("tool")
  })
  test("pending permission is waiting regardless of status", () => {
    expect(build([user("u1")], {}, "busy", [{ kind: "permission", request: { id: "per_1" } }]).phase).toBe("waiting")
    expect(build([user("u1")], {}, "idle", [{ kind: "question", request: { id: "que_1" } }]).phase).toBe("waiting")
  })
  test("retry status is error", () => {
    expect(build([user("u1")], {}, "retry").phase).toBe("error")
  })
  test("idle after an assistant reply is complete; idle with only a user message is idle", () => {
    expect(build([user("u1"), assistant("a1")], { a1: [text("t1", "a1", "done", 30)] }, "idle").phase).toBe("complete")
    expect(build([user("u1")], {}, "idle").phase).toBe("idle")
    expect(build([], {}, "idle").phase).toBe("idle")
  })
  test("an older part without an end time is history, not streaming", () => {
    expect(build([user("u1"), assistant("a1"), user("u2")], { a1: [text("t1", "a1", "old")] }).phase).toBe("thinking")
  })
  test("a completed assistant message is never streaming even while the session is busy", () => {
    const done = { ...assistant("a1"), time: { created: 2, completed: 3 } } as Message
    expect(build([user("u1"), done], { a1: [text("t1", "a1", "old")] }).phase).toBe("thinking")
  })
  test("subagents running keep the session busy when its own status is idle", () => {
    expect(build([user("u1"), assistant("a1")], { a1: [tool("k1", "a1", "running", "task")] }, "idle", [], 1).phase).toBe("thinking")
  })
})

describe("snapshot nodes", () => {
  test("one node per user message, text, reasoning and tool part; task tools become branches", () => {
    const s = build([user("u1"), assistant("a1")], { a1: [text("t1", "a1", "hi", 30), tool("c1", "a1", "completed"), tool("k1", "a1", "running", "task")] })
    expect(s.nodes.map((n) => [n.id, n.kind, n.status])).toEqual([["u1", "user", "done"], ["t1", "text", "done"], ["c1", "tool", "done"], ["k1", "task", "running"]])
    expect(s.branches).toEqual([{ id: "k1", alive: true, first: "k1", last: "k1" }])
  })
  test("pending request appends an open ask node anchored by request id", () => {
    const s = build([user("u1")], {}, "busy", [{ kind: "question", request: { id: "que_9" } }])
    expect(s.nodes.at(-1)).toMatchObject({ id: "que_9", anchor: "ask", kind: "ask", status: "open", askKind: "question" })
    expect(s.waiting).toEqual({ id: "que_9", kind: "question" })
  })
  test("errored tools are counted", () => {
    expect(build([assistant("a1")], { a1: [tool("c1", "a1", "error")] }).errors).toBe(1)
  })
})

describe("diff", () => {
  test("text growth emits one delta with the grown length", () => {
    const a = build([assistant("a1")], { a1: [text("t1", "a1", "hel")] })
    const b = build([assistant("a1")], { a1: [text("t1", "a1", "hello wor")] })
    expect(diff(a, b)).toEqual([{ type: "text", id: "t1", kind: "text", grew: 6 }])
  })
  test("tool completion and failure emit tool.end once", () => {
    const a = build([assistant("a1")], { a1: [tool("c1", "a1", "running")] })
    const ok = build([assistant("a1")], { a1: [tool("c1", "a1", "completed")] }, "idle")
    const bad = build([assistant("a1")], { a1: [tool("c1", "a1", "error")] }, "idle")
    expect(diff(a, ok)).toContainEqual({ type: "tool.end", id: "c1", status: "done" })
    expect(diff(a, bad)).toContainEqual({ type: "tool.end", id: "c1", status: "error" })
    expect(diff(ok, ok)).toEqual([])
  })
  test("ask open and close, and phase changes, are reported", () => {
    const a = build([user("u1")], {})
    const b = build([user("u1")], {}, "busy", [{ kind: "permission", request: { id: "per_1" } }])
    expect(diff(a, b)).toEqual([{ type: "ask.open", id: "per_1" }, { type: "phase", from: "thinking", to: "waiting" }])
    expect(diff(b, a)).toEqual([{ type: "ask.closed", id: "per_1" }, { type: "phase", from: "waiting", to: "thinking" }])
  })
  test("no previous snapshot yields no deltas (history load is not a burst)", () => {
    expect(diff(undefined, build([assistant("a1")], { a1: [text("t1", "a1", "loaded")] }))).toEqual([])
  })
})

describe("cache continuity per provider turn", () => {
  const tokens = (read: number, write: number, input = 0) => ({ input, cache: { read, write } })
  const steps = (usage?: ReturnType<typeof tokens>): StepPart[] => [{ id: "s1", type: "step-start" }, ...(usage ? [{ id: "f1", type: "step-finish" as const, tokens: usage }] : [])]
  const turn = (st: StepPart[], status = "idle") => build([user("u1"), assistant("a1")], { a1: [text("t1", "a1", "hi", 5)] }, status, [], 0, { a1: st }).turns[0]
  test("zero-filled usage is unknown, not a miss", () => {
    expect(turn(steps(tokens(0, 0))).cache).toBe("unknown")
  })
  test("read only is warm; explicit write only is cold; read with write is mixed", () => {
    expect(turn(steps(tokens(900, 0))).cache).toBe("warm")
    expect(turn(steps(tokens(0, 900))).cache).toBe("cold")
    expect(turn(steps(tokens(900, 120))).cache).toBe("mixed")
  })
  test("uncached input alone is never a miss or a write", () => {
    expect(turn(steps(tokens(0, 0, 900))).cache).toBe("unknown")
    expect(turn(steps(tokens(900, 0, 300))).cache).toBe("warm")
  })
  test("a completed message without step parts gets no boundary (message.tokens is only the last step)", () => {
    const done = { ...assistant("a1"), tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 900, write: 0 } }, time: { created: 2, completed: 3 } } as Message
    expect(build([user("u1"), done], { a1: [text("t1", "a1", "hi", 5)] }, "idle").turns).toEqual([])
  })
  test("an open step is provisional; the late step-finish updates the same turn and emits a cache delta", () => {
    const before = build([user("u1"), assistant("a1")], { a1: [text("t1", "a1", "hi")] }, "busy", [], 0, { a1: steps() })
    expect(before.turns[0]).toMatchObject({ anchor: "t1", cache: "unknown", settled: false })
    const after = build([user("u1"), assistant("a1")], { a1: [text("t1", "a1", "hi", 5)] }, "idle", [], 0, { a1: steps(tokens(800, 0)) })
    expect(after.turns).toHaveLength(1)
    expect(diff(before, after)).toContainEqual({ type: "cache", messageID: "a1", from: "unknown", to: "warm" })
  })
  test("orphan step-finish is not placed", () => {
    expect(turn([{ id: "f0", type: "step-finish", tokens: tokens(500, 0) }])).toBeUndefined()
  })
})

describe("provider turns per step", () => {
  test("two steps in one message are two turns, each anchored at the step's drawable node in order; tool parts add no boundary", () => {
    // Ids are time-ordered: step-start prt_0 < text prt_1 < finish prt_1b < step-start prt_1c < tool prt_2 < finish prt_3.
    const s = build([user("u1"), assistant("a1")], { a1: [text("prt_1", "a1", "first", 5), tool("prt_2", "a1", "completed"), text("prt_4", "a1", "second", 9)] }, "idle", [], 0,
      { a1: [{ id: "prt_0", type: "step-start" }, { id: "prt_1b", type: "step-finish", tokens: { input: 0, cache: { read: 500, write: 0 } } }, { id: "prt_1c", type: "step-start" }, { id: "prt_3", type: "step-finish", tokens: { input: 0, cache: { read: 500, write: 80 } } }] })
    expect(s.turns.map((t) => [t.anchor, t.cache])).toEqual([["prt_1", "warm"], ["prt_2", "mixed"]])
  })
})

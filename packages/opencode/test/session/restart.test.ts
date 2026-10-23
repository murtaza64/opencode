import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionRestart } from "@/session/restart"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_restart")
const userID = MessageID.make("msg_user")
const anchorID = MessageID.make("msg_anchor")
const payload = { restartID: "restart-1-2", anchorMessageID: anchorID, capturedAt: 150 }

const user: SessionV1.User = {
  id: userID,
  sessionID,
  role: "user",
  agent: "build",
  time: { created: 50 },
  model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("m") },
}

const assistant = (extra: Partial<SessionV1.Assistant> = {}): SessionV1.Assistant => ({
  id: anchorID,
  sessionID,
  role: "assistant",
  parentID: userID,
  agent: "build",
  mode: "build",
  modelID: ModelV2.ID.make("m"),
  providerID: ProviderV2.ID.make("test"),
  time: { created: 100 },
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
})

const tool = (state: SessionV1.ToolState): SessionV1.ToolPart => ({
  id: PartID.ascending(),
  sessionID,
  messageID: anchorID,
  type: "tool",
  callID: `call_${state.status}`,
  tool: "bash",
  state,
})
const running = tool({ status: "running", input: {}, time: { start: 100 } })
const pending = tool({ status: "pending", input: {}, raw: "" })
const done = tool({ status: "completed", input: {}, output: "ok", title: "", metadata: {}, time: { start: 100, end: 101 } })
const cancelled = tool({ status: "error", input: {}, error: "aborted", metadata: { interrupted: true }, time: { start: 100, end: 120 } })
const aborted = new SessionV1.AbortedError({ message: "Aborted" }).toObject()

const decide = (info: SessionV1.Assistant | SessionV1.User, parts: SessionV1.Part[], pendingInput = false) => {
  const anchor = { info, parts }
  return SessionRestart.decide({
    payload,
    now: 250,
    anchor,
    newest: { byTime: info.id, byInsertion: info.id },
    turn: { user, assistant: info.role === "assistant" ? anchor : undefined },
    pendingInput,
  })
}

describe("restart continuation eligibility", () => {
  test("an abort inside the restart window with a running tool is uncertain, never scheduled", () => {
    expect(decide(assistant({ error: aborted, time: { created: 100, completed: 200 } }), [running])).toMatchObject({
      outcome: "uncertain",
      marker: { outcome: "uncertain", reason: "interrupted-tool", interruptedTools: 1 },
    })
  })

  test("any unknown tool effect blocks resumption whatever else the step looks like", () => {
    const cases: [SessionV1.Assistant, SessionV1.Part[]][] = [
      [assistant(), [done, running]],
      [assistant(), [pending]],
      [assistant({ error: aborted, time: { created: 100, completed: 200 } }), [done, cancelled]],
      [assistant({ finish: "tool-calls", time: { created: 100, completed: 120 } }), [done, running]],
      // Structured output makes a turn look complete even with tool parts left behind.
      [assistant({ structured: { ok: true }, finish: "stop", time: { created: 100, completed: 120 } }), [running]],
      [assistant({ finish: "stop", time: { created: 100, completed: 120 } }), [cancelled]],
    ]
    for (const [info, parts] of cases)
      expect([decide(info, parts, true).outcome, decide(info, parts, false).outcome]).toEqual(["uncertain", "uncertain"])
  })

  test("durable boundaries resume", () => {
    expect(decide(assistant(), [done]).outcome).toBe("scheduled")
    expect(decide(assistant({ finish: "tool-calls", time: { created: 100, completed: 120 } }), [done]).outcome).toBe("scheduled")
    expect(decide(assistant({ error: aborted, time: { created: 100, completed: 200 } }), []).outcome).toBe("scheduled")
    expect(decide({ ...user, id: anchorID, time: { created: 100 } }, []).outcome).toBe("scheduled")
  })

  test("an abort before the restart, a failed turn and a finished turn do not resume", () => {
    expect(decide(assistant({ error: aborted, time: { created: 100, completed: 120 } }), [])).toMatchObject({
      outcome: "uncertain",
      marker: { reason: "aborted" },
    })
    const failed = new SessionV1.APIError({ message: "x", isRetryable: false }).toObject()
    expect(decide(assistant({ error: failed, time: { created: 100, completed: 120 } }), []).outcome).toBe("failed")
    expect(decide(assistant({ finish: "stop", time: { created: 100, completed: 120 } }), []).outcome).toBe("complete")
  })

  test("a full marker list refuses new restart IDs instead of forgetting old ones", () => {
    const restarts = Array.from({ length: SessionRestart.MAX_MARKERS }, (_, index) => ({
      restartID: `restart-${index}`,
      outcome: "uncertain" as const,
      reason: "aborted" as const,
      interruptedTools: 0,
      time: 200,
    }))
    expect(decide(assistant({ restarts }), [done]).outcome).toBe("capacity")
    const decision = decide(assistant({ restarts: restarts.slice(1) }), [done])
    if (decision.outcome !== "scheduled") throw new Error(`expected scheduled, got ${decision.outcome}`)
    expect(SessionRestart.settle(decision, 250).restarts?.map((marker) => marker.restartID)).toEqual([
      ...restarts.slice(1).map((marker) => marker.restartID),
      "restart-1-2",
    ])
  })
})

describe("empty steps opened after the anchor", () => {
  const header = (extra: Partial<SessionV1.Assistant> = {}, parts: SessionV1.Part[] = []) => {
    const id = MessageID.make("msg_zheader")
    return { info: { ...assistant({ finish: undefined }), id, time: { created: 200 }, ...extra }, parts: [
      { id: PartID.ascending(), sessionID, messageID: id, type: "step-start" } as SessionV1.Part, ...parts] }
  }
  const anchorStep = { info: assistant({ finish: "tool-calls", time: { created: 100, completed: 120 } }), parts: [done] }
  const run = (later: SessionV1.WithParts[], newest = later.at(-1)!.info.id) => SessionRestart.decide({
    payload, now: 250, anchor: anchorStep, newest: { byTime: newest, byInsertion: newest },
    turn: { user, assistant: later.at(-1) ?? anchorStep }, pendingInput: true, later,
  })

  test("only a producing-nothing step is skipped, and it is closed when the turn resumes", () => {
    const empty = header()
    const decision = run([empty])
    if (decision.outcome !== "scheduled") throw new Error(decision.outcome)
    expect(decision.trailing.map((message) => message.info.id)).toEqual([empty.info.id])
    expect(SessionRestart.closeTrailing(decision, 250)).toMatchObject([{ id: empty.info.id, error: { name: "MessageAbortedError" }, time: { completed: 250 } }])
  })

  test("output, a tool, an error, or a finish is progress", () => {
    const text = { id: PartID.ascending(), sessionID, messageID: MessageID.make("msg_zheader"), type: "text", text: "hi" } as SessionV1.Part
    for (const step of [header({}, [text]), header({}, [{ ...running, messageID: MessageID.make("msg_zheader") }]),
      header({ error: aborted, time: { created: 200, completed: 210 } }), header({ finish: "stop", time: { created: 200, completed: 210 } })])
      expect(run([step]).outcome).toBe("advanced")
  })

  test("a newest row outside the anchor and its empty steps is progress", () => {
    expect(run([header()], MessageID.make("msg_zz_other")).outcome).toBe("advanced")
  })
})

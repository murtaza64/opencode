import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { restartMarkers } from "./restart-marker"

const user = (id: string): UserMessage => ({
  id,
  sessionID: "ses_1",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "test", modelID: "m" },
})

const assistant = (id: string, created: number, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  sessionID: "ses_1",
  role: "assistant",
  time: { created },
  parentID: "msg_1",
  modelID: "m",
  providerID: "test",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
})

const anchor = (outcome: "scheduled" | "uncertain", reason?: "interrupted-tool" | "aborted" | "out-of-order", interruptedTools = 0) =>
  assistant("msg_2", 10, {
    error: { name: "MessageAbortedError", data: { message: "Interrupted by an OpenCode daemon restart" } },
    restarts: [{ restartID: "restart-1-2", outcome, ...(reason ? { reason } : {}), interruptedTools, time: 100 }],
  })

describe("restart markers", () => {
  test("claims resumed only when an assistant message started after the decision", () => {
    const interrupted = anchor("scheduled")
    const history: Message[] = [user("msg_1"), interrupted, assistant("msg_3", 120)]
    expect(restartMarkers(interrupted, history, false)).toEqual([
      { restartID: "restart-1-2", state: "resumed", label: "Resumed after daemon restart" },
    ])
  })

  test("is still resuming while the session is busy without new output", () => {
    const interrupted = anchor("scheduled")
    expect(restartMarkers(interrupted, [user("msg_1"), interrupted], true)[0]).toMatchObject({
      state: "resuming",
      label: "Resuming after daemon restart",
    })
  })

  test("an idle session with no output after a scheduled continuation is uncertain, not resumed", () => {
    const interrupted = anchor("scheduled")
    // An assistant row older than the decision is not evidence of the continuation.
    const history: Message[] = [user("msg_1"), interrupted, assistant("msg_3", 50)]
    expect(restartMarkers(interrupted, history, false)[0]).toMatchObject({
      state: "uncertain",
      label: "Daemon restart · resume scheduled, no progress observed",
    })
  })

  test("uncertain admission explains why nothing resumed, even while busy or after later output", () => {
    const cut = anchor("uncertain", "interrupted-tool", 2)
    expect(restartMarkers(cut, [cut], true)[0]).toMatchObject({
      state: "uncertain",
      label: "Daemon restart · not resumed: a tool may have partly run · 2 tools to check",
    })
    const stopped = anchor("uncertain", "aborted")
    expect(restartMarkers(stopped, [stopped, assistant("msg_3", 500)], false)[0]).toMatchObject({
      state: "uncertain",
      label: "Daemon restart · not resumed: stopped before the restart",
    })
    const skewed = anchor("uncertain", "out-of-order", 1)
    expect(restartMarkers(skewed, [skewed], true)[0]?.label).toBe(
      "Daemon restart · not resumed: message clock out of order · 1 tool to check",
    )
  })

  test("messages without restart provenance render nothing", () => {
    expect(restartMarkers(user("msg_1"), [user("msg_1")], true)).toEqual([])
  })
})

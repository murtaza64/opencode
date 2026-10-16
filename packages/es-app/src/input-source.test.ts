import { describe, expect, test } from "bun:test"
import { sourcedInput } from "./input-source"

const user = (source?: unknown) => ({ role: "user", ...(source === undefined ? {} : { source }) })

describe("sourcedInput", () => {
  test("leaves human, absent, mail and assistant messages to their own renderers", () => {
    expect(sourcedInput(user())).toBeUndefined()
    expect(sourcedInput(user({ type: "human", via: "es-app" }))).toBeUndefined()
    expect(sourcedInput(user({ type: "editspace-mail", id: "m", sender: "a", recipient: "b" }))).toBeUndefined()
    expect(sourcedInput({ role: "assistant", source: { type: "resume", sender: "orchestrator" } })).toBeUndefined()
  })

  test("classifies resume, handoff and subagent returns as agent input", () => {
    expect(sourcedInput(user({ type: "resume", sender: "orchestrator", in_reply_to: "project#9" }))).toEqual({
      type: "resume",
      category: "agent",
      label: "Resume",
      from: "orchestrator",
      headers: [
        { name: "From", value: "orchestrator" },
        { name: "Reply to", value: "project#9" },
      ],
    })
    expect(sourcedInput(user({ type: "handoff", predecessor: "ses_old", lane: "lane-a" }))).toMatchObject({
      category: "agent",
      from: "ses_old",
    })
    expect(sourcedInput(user({ type: "subagent-return", sessionID: "ses_c", agent: "explore" }))).toMatchObject({
      category: "agent",
      label: "Subagent",
      from: "explore",
    })
  })

  test("classifies heartbeats as system input", () => {
    expect(sourcedInput(user({ type: "heartbeat", sender: "launchd" }))).toMatchObject({
      category: "system",
      label: "Heartbeat",
    })
  })

  test("rejects malformed sources instead of trusting partial metadata", () => {
    expect(sourcedInput(user({ type: "resume" }))).toBeUndefined()
    expect(sourcedInput(user({ type: "resume", sender: 42 }))).toBeUndefined()
    expect(sourcedInput(user({ type: "handoff" }))).toBeUndefined()
    expect(sourcedInput(user({ type: "cron", sender: "x" }))).toBeUndefined()
    expect(sourcedInput(user("resume"))).toBeUndefined()
  })
})

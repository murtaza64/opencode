import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { InputSourceContext } from "@opencode-ai/core/session/input-source"
import { SessionInput } from "@opencode-ai/core/session/input"

const decode = Schema.decodeUnknownOption(SessionInput.InputSource)

describe("SessionInput.InputSource", () => {
  test("accepts every provenance type", () => {
    const sources = [
      { type: "human" },
      { type: "human", via: "es-app" },
      { type: "editspace-mail", id: "project#1", sender: "a", recipient: "b" },
      { type: "resume", sender: "orchestrator" },
      { type: "resume", sender: "orchestrator", senderSession: "ses_x", in_reply_to: "project#1" },
      { type: "heartbeat", sender: "launchd" },
      { type: "subagent-return", sessionID: "ses_child", status: "failed" },
      { type: "handoff", predecessor: "ses_old" },
    ]
    for (const source of sources) expect(Option.isSome(decode(source))).toBe(true)
  })

  test("rejects unknown types and missing required identity fields", () => {
    expect(Option.isNone(decode({ type: "cron" }))).toBe(true)
    expect(Option.isNone(decode({ type: "resume" }))).toBe(true)
    expect(Option.isNone(decode({ type: "editspace-mail", id: "x", sender: "a" }))).toBe(true)
    expect(Option.isNone(decode({ type: "subagent-return" }))).toBe(true)
    expect(Option.isNone(decode({ type: "handoff" }))).toBe(true)
    expect(Option.isNone(decode({ type: "subagent-return", sessionID: "ses_c", status: "lost" }))).toBe(true)
  })

  test("only human or absent sources carry user trust", () => {
    expect(InputSourceContext.isAgentSource(undefined)).toBe(false)
    expect(InputSourceContext.isAgentSource({ type: "human" })).toBe(false)
    expect(InputSourceContext.isAgentSource({ type: "resume", sender: "orchestrator" })).toBe(true)
    expect(InputSourceContext.isAgentSource({ type: "heartbeat", sender: "launchd" })).toBe(true)
  })
})

describe("InputSourceContext.format", () => {
  test("renders mail as a header block followed by the raw body with real newlines", () => {
    const text = InputSourceContext.format(
      {
        type: "editspace-mail",
        id: "project#31",
        sender: "reviewer",
        senderSession: "ses_rev",
        recipient: "parent",
        kind: "answer",
        in_reply_to: "project#30",
      },
      ["Line one\n\nLine three", "[Attached text/plain: notes.md]"],
    )
    expect(text).toBe(
      [
        "Source: editspace-mail",
        "From: reviewer",
        "From-Session: ses_rev",
        "To: parent",
        "Kind: answer",
        "In-reply-to: project#30",
        "Mail-ID: project#31",
        "",
        "Line one",
        "",
        "Line three",
        "[Attached text/plain: notes.md]",
      ].join("\n"),
    )
    expect(text).not.toContain("\\n")
    expect(text).not.toContain("lower-trust")
  })

  test("omits absent headers and empty body segments", () => {
    expect(InputSourceContext.format({ type: "heartbeat", sender: "launchd" }, [""])).toBe(
      "Source: heartbeat\nFrom: launchd",
    )
    expect(InputSourceContext.format({ type: "handoff", predecessor: "ses_old" }, ["", "brief"])).toBe(
      "Source: handoff\nFrom-Session: ses_old\n\nbrief",
    )
  })

  test("labels each agent source for compaction summaries", () => {
    expect(InputSourceContext.label({ type: "editspace-mail", id: "m", sender: "a", recipient: "b" })).toBe(
      "Peer agent mail",
    )
    expect(InputSourceContext.label({ type: "resume", sender: "o" })).toBe("Resume")
    expect(InputSourceContext.label({ type: "heartbeat", sender: "l" })).toBe("Heartbeat")
    expect(InputSourceContext.label({ type: "subagent-return", sessionID: "s" })).toBe("Subagent return")
    expect(InputSourceContext.label({ type: "handoff", predecessor: "p" })).toBe("Handoff")
  })

  test("states the trust rule as system context naming the header convention", () => {
    expect(InputSourceContext.SYSTEM_RULE).toContain("`Source:`")
    expect(InputSourceContext.SYSTEM_RULE).toContain("lower-trust")
    expect(InputSourceContext.SYSTEM_RULE).toContain("human user")
  })
})

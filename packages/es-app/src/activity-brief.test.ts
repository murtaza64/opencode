import { describe, expect, test } from "bun:test"
import { activityBrief, activityBriefLabel, type ActivityBriefInput } from "./activity-brief"

const now = 1_800_000_000_000
const input: ActivityBriefInput = {
  sessionID: "ses_current",
  status: "busy",
  report: { sessionID: "ses_current", owner: "ses_current", text: "Checking the composer", at: now - 60_000 },
  todos: [{ content: "Verify activity", status: "in_progress" }],
  tools: [{ name: "bash", status: "running", at: now - 20_000 }],
}

describe("activityBrief", () => {
  test("prefers a fresh report scoped to the current owner and session", () => {
    expect(activityBrief(input, now)).toEqual({ text: "Checking the composer", source: "reported", at: now - 60_000 })
  })

  test("expires reports instead of presenting them as current work", () => {
    expect(activityBrief({ ...input, report: { ...input.report!, at: now - 300_001 } }, now)).toEqual({
      text: "Verify activity",
      source: "todo",
      at: undefined,
    })
  })

  test("rejects reports inherited by a handoff successor", () => {
    expect(activityBrief({ ...input, sessionID: "ses_successor" }, now).source).toBe("todo")
  })

  test("rejects former-owner reports even when the session matches", () => {
    expect(activityBrief({ ...input, report: { ...input.report!, owner: "ses_former" } }, now).source).toBe("todo")
  })

  test("rejects future, invalid and missing report timestamps", () => {
    expect(activityBrief({ ...input, report: { ...input.report!, at: now + 1 } }, now).source).toBe("todo")
    expect(activityBrief({ ...input, report: { ...input.report!, at: NaN } }, now).source).toBe("todo")
    expect(activityBrief({ ...input, report: { ...input.report!, at: 0 } }, now).source).toBe("todo")
  })

  test("falls back to a running tool when TODOs are absent", () => {
    expect(activityBrief({ ...input, report: undefined, todos: undefined }, now)).toEqual({
      text: "bash",
      source: "tool",
      at: now - 20_000,
    })
  })

  test("never treats a pending or completed TODO as current work", () => {
    expect(
      activityBrief(
        {
          ...input,
          report: undefined,
          todos: [
            { content: "Next", status: "pending" },
            { content: "Done", status: "completed" },
          ],
        },
        now,
      ).source,
    ).toBe("tool")
  })

  test("follows running tool changes and ignores completed or foreign tools", () => {
    expect(
      activityBrief(
        {
          sessionID: "ses_current",
          status: "busy",
          tools: [
            { name: "bash", status: "completed" },
            { name: "read", status: "running", sessionID: "ses_current" },
            { name: "foreign", status: "running", sessionID: "ses_other" },
          ],
        },
        now,
      ).text,
    ).toBe("read")
  })

  test("does not render command-like tool names", () => {
    expect(
      activityBrief(
        { sessionID: "ses_current", status: "busy", tools: [{ name: "bash --private-argument", status: "running" }] },
        now,
      ),
    ).toEqual({ text: "Working", source: "status" })
  })

  test("idle and unknown status suppress previous reports, TODOs and tools", () => {
    expect(activityBrief({ ...input, status: "idle" }, now)).toEqual({ text: "Idle", source: "status" })
    expect(activityBrief({ ...input, status: "unknown" }, now)).toEqual({ text: "Activity unknown", source: "status" })
  })

  test("keeps mixed-direction content bounded and single-line", () => {
    const brief = activityBrief(
      {
        sessionID: "ses_current",
        status: "busy",
        todos: [{ content: `  مراجعة src/file.ts\n  ${"long ".repeat(100)}\u202e`, status: "in_progress" }],
      },
      now,
    )
    expect(brief.text).toStartWith("مراجعة src/file.ts long")
    expect(brief.text.length).toBeLessThanOrEqual(200)
    expect(brief.text).not.toMatch(/[\n\u202e]/)
  })
})

test("source labels distinguish unknown age from actual source timestamps", () => {
  expect(activityBriefLabel({ text: "Task", source: "todo" }, now)).toBe("TODO · age unknown")
  expect(activityBriefLabel({ text: "Task", source: "reported", at: now - 60_000 }, now)).toBe("reported · 1m ago")
  expect(activityBriefLabel({ text: "read", source: "tool", at: now - 20_000 }, now)).toBe("tool · 20s ago")
})

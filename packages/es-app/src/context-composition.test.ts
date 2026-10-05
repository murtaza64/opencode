import { describe, expect, test } from "bun:test"
import { compositionSlices, estimateComposition } from "./context-composition"
import { contextUsage } from "./context-usage"

describe("visible composition", () => {
  test("estimates may exceed exact provider usage without a fabricated remainder or scaling", () => {
    const slices = compositionSlices({ basis: "full_history", messages: 1, chars: {
      user_text: 8000, assistant_text: 4000, tool_metadata: 0, tool_output: 0, other: 400,
    } })
    expect(slices.find((slice) => slice.key === "user_text")?.tokens).toBe(2000)
    expect(slices.find((slice) => slice.key === "other")?.tokens).toBe(100)
    expect(slices.reduce((total, slice) => total + slice.tokens, 0)).toBe(3100)
    expect(slices.reduce((total, slice) => total + slice.share, 0)).toBeCloseTo(1)
  })

  test("no completed compaction marker estimates full stored visible history", () => {
    const result = estimateComposition([{ id: "u", role: "user" }, { id: "a", role: "assistant" }], {
      u: [{ type: "text", text: "user" }], a: [{ type: "text", text: "assistant" }],
    })
    expect(result.basis).toBe("full_history")
    expect(result.chars.user_text).toBe(4)
    expect(result.chars.assistant_text).toBe(9)
  })

  test("a completed compaction scopes visible estimates, without attributing older content", () => {
    const result = estimateComposition([
      { id: "old", role: "user" },
      { id: "summary", role: "assistant", parentID: "old", summary: true, time: { completed: 1 } },
      { id: "new", role: "user" },
    ], { old: [{ type: "text", text: "old" }], summary: [{ type: "text", text: "summary" }], new: [{ type: "text", text: "new" }] })
    expect(result.basis).toBe("since_compaction")
    expect(result.chars.user_text).toBe(3)
    expect(result.chars.assistant_text).toBe(7)
  })

  test("empty visible and zero provider usage stay unknown", () => {
    expect(compositionSlices(null)).toEqual([])
    expect(compositionSlices({ basis: "full_history", messages: 0, chars: {
      user_text: 0, assistant_text: 0, tool_metadata: 0, tool_output: 0, other: 0,
    } })).toEqual([])
    expect(contextUsage({ providerID: "p", modelID: "m", tokens: { input: 0, output: 0, reasoning: 0 } }, undefined)).toBeNull()
  })
})

import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { magnitudeLabel, magnitudeRange, sizeClass, sizeDistribution, toolMagnitude } from "./tool-magnitude"

let next = 0
const completed = (input: Record<string, unknown>, output: string, extra: Partial<{ start: number; end: number; compacted: number; attachments: unknown[] }> = {}) => ({
  id: `prt_${++next}`, sessionID: "ses", messageID: "msg", type: "tool", callID: `call_${next}`, tool: "bash",
  state: { status: "completed", input, output, title: "", metadata: {}, time: { start: extra.start ?? 1000, end: extra.end ?? 1500, compacted: extra.compacted },
    attachments: extra.attachments },
}) as ToolPart

describe("tool magnitude", () => {
  test("classes are stable at the documented character thresholds", () => {
    expect([0, 999, 1000, 2999, 3000, 9999, 10_000, 29_999, 30_000, 5_000_000].map(sizeClass)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
  })

  test("sums input text and output text and reports wall time separately", () => {
    const magnitude = toolMagnitude(completed({ command: "x".repeat(500), nested: { list: ["y".repeat(600)] } }, "z".repeat(1800), { start: 0, end: 600_000 }))
    expect(magnitude).toMatchObject({ kind: "sized", size: "S", input: 1100, output: 1800, partial: false, ms: 600_000 })
    expect(magnitudeLabel(magnitude)).toBe("Size S: ~2.9k characters (input 1.1k, output 1.8k) · 10m 00s wall time")
  })

  test("a long wall time never raises the size class", () => {
    expect(toolMagnitude(completed({}, "ok", { start: 0, end: 3_600_000 }))).toMatchObject({ size: "XS" })
  })

  test("error text is measured like output", () => {
    const part = completed({}, "")
    part.state = { status: "error", input: {}, error: "e".repeat(12_000), time: { start: 0, end: 1 } }
    expect(toolMagnitude(part)).toMatchObject({ kind: "sized", size: "L", output: 12_000 })
  })

  test("running and pending calls have no size yet", () => {
    const part = completed({}, "")
    part.state = { status: "running", input: { command: "x".repeat(50_000) }, time: { start: 0 } }
    expect(toolMagnitude(part).kind).toBe("running")
    expect(magnitudeLabel(toolMagnitude(part))).toBe("Size not known yet: tool is running")
    part.state = { status: "pending", input: {}, raw: "" }
    expect(toolMagnitude(part).kind).toBe("running")
  })

  test("compacted output is unknown, not small", () => {
    const magnitude = toolMagnitude(completed({}, "[cleared]", { compacted: 5 }))
    expect(magnitude).toMatchObject({ kind: "unknown" })
    expect(magnitudeLabel(magnitude)).toStartWith("Size unknown: output was cleared by compaction")
  })

  test("attachments are counted but not sized", () => {
    const magnitude = toolMagnitude(completed({}, "ok", { attachments: [{ url: `data:image/png;base64,${"A".repeat(100_000)}` }] }))
    expect(magnitude).toMatchObject({ kind: "sized", size: "XS", attachments: 1 })
    expect(magnitudeLabel(magnitude)).toContain("1 attachment(s) not counted")
  })

  test("huge structured inputs are walked within a fixed budget and marked as a lower bound", () => {
    const magnitude = toolMagnitude(completed({ items: Array.from({ length: 100_000 }, (_, index) => `item ${index}`) }, ""))
    expect(magnitude).toMatchObject({ kind: "sized", partial: true })
    expect(magnitude.kind === "sized" && magnitude.input).toBeLessThan(400 * 12)
    expect(magnitudeLabel(magnitude)).toContain("at least")
  })

  test("truncated shell output is a lower bound", () => {
    const part = completed({ command: "cat big" }, "x".repeat(500))
    if (part.state.status === "completed") part.state.metadata = { exit: 0, truncated: true }
    const magnitude = toolMagnitude(part)
    expect(magnitude).toMatchObject({ kind: "sized", partial: true })
    expect(magnitudeLabel(magnitude)).toContain("at least 507 characters")
    expect(magnitudeLabel(magnitude)).toContain("lower bound")
  })

  test("ranges span sized members and count unsized ones", () => {
    const running = completed({}, "")
    running.state = { status: "running", input: {}, time: { start: 0 } }
    expect(magnitudeRange([completed({}, "a"), completed({}, "b".repeat(2500)), running].map(toolMagnitude)))
      .toEqual({ low: "XS", high: "S", rank: 1, chars: 2501, unknown: 1 })
    expect(magnitudeRange([running].map(toolMagnitude))).toBeUndefined()
  })
})

describe("size distribution", () => {
  const sized = (chars: number) => toolMagnitude(completed({}, "x".repeat(chars)))

  test("counts calls per class in canonical order, showing only nonzero classes", () => {
    const result = sizeDistribution([sized(40_000), sized(10), sized(5_000), sized(20), sized(15_000), sized(2_000), sized(30)])
    expect(result.text).toBe("XS×3 · S×1 · M×1 · L×1 · XL×1")
    expect(result.label).toBe("Size distribution of 7 calls: 3 XS, 1 S, 1 M, 1 L, 1 XL")
    expect(sizeDistribution([sized(10), sized(5_000), sized(6_000)]).text).toBe("XS×1 · M×2")
  })

  test("lower-bound, compacted, unavailable and running sizes are unknown with reasons, and counts sum to the batch", () => {
    const truncated = completed({}, "x")
    truncated.state = { ...truncated.state, metadata: { truncated: true } } as ToolPart["state"]
    const capped = completed(Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, "v"])), "x")
    const running = completed({}, "x")
    running.state = { status: "running", input: {}, time: { start: 0 } }
    const items = [sized(10), toolMagnitude(truncated), toolMagnitude(capped), toolMagnitude(completed({}, "x", { compacted: 5 })), toolMagnitude(running)]
    const result = sizeDistribution(items)
    expect(result.text).toBe("XS×1 · ?×4")
    expect(result.bins.reduce((sum, bin) => sum + bin.count, 0) + result.unknown).toBe(items.length)
    expect(result.label).toBe("Size distribution of 5 calls: 1 XS, 4 not sized (lower bound only: input walk capped or output truncated ×2; " +
      "output was cleared by compaction ×1; tool is running ×1)")
  })

  test("attachments keep the text-size class and are stated as excluded", () => {
    const result = sizeDistribution([toolMagnitude(completed({}, "ok", { attachments: [{ type: "file" }] })), sized(10)])
    expect(result.text).toBe("XS×2")
    expect(result.label).toBe("Size distribution of 2 calls: 2 XS; attachments in 1 call(s) not counted")
  })

  test("wall time never moves a call to another class", () => {
    expect(sizeDistribution([toolMagnitude(completed({}, "ok", { start: 0, end: 7_200_000 })), sized(10)]).text).toBe("XS×2")
  })
})

import { describe, expect, test } from "bun:test"
import type { UsageDaily } from "./api"
import { costSummary } from "./today-cost"

const NOW = Date.parse("2026-10-28T12:00:00Z")
const tokens = { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
const laptop = { id: "laptop", label: "Laptop", base: "", current: true }
const mini = { id: "mini", label: "Mini", base: "/hosts/mini", current: false }

const originRollup = (cost: number, extra: Partial<UsageDaily["days"][number]> = {}): UsageDaily => ({
  estimate: true, basis: "", host: "h", observedAt: new Date(NOW).toISOString(), offsetMinutes: -240,
  coverage: { scope: "", backfilled: true },
  days: [{ day: "2026-10-28", cost, complete: true, originOnly: true, originCost: cost, unpricedModels: 0,
    models: [{ provider: "a", model: "m", cost, coverage: "priced", tokens }], ...extra }],
  rateLimits: { source: "headers", providers: [] },
})
/** An installed Core without origin-only cost (no originOnly/originCost fields). */
const olderRollup = (cost: number, observedAt = new Date(NOW).toISOString()): UsageDaily => ({
  estimate: true, basis: "", host: "h", observedAt, offsetMinutes: -240,
  coverage: { scope: "", backfilled: true },
  days: [{ day: "2026-10-28", cost, complete: true, unpricedModels: 0, models: [{ provider: "a", model: "m", cost, coverage: "priced", tokens }] }],
  rateLimits: { source: "headers", providers: [] },
})

describe("costSummary", () => {
  test("both hosts origin-supported: combined total of origin-only costs, exact", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(40), readAt: NOW },
      mini: { value: originRollup(25), readAt: NOW },
    }, NOW)
    expect(summary?.total).toBe(65)
    expect(summary?.partial).toBe(false)
    expect(summary?.gaps).toEqual([])
  })

  test("history copied to another host is counted once: origin cost, not the host's raw daily cost", () => {
    // Mini's raw 600 includes laptop-run history copied with a migrated session; it ran 25 itself.
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(50), readAt: NOW },
      mini: { value: originRollup(600, { originCost: 25 }), readAt: NOW },
    }, NOW)
    expect(summary?.total).toBe(75)
  })

  test("mixed capability: one host without origin-only cost makes the summary partial with no amount", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(40), readAt: NOW },
      mini: { value: olderRollup(25), readAt: NOW },
    }, NOW)
    expect(summary?.total).toBeUndefined()
    expect(summary?.partial).toBe(true)
    expect(summary?.gaps.map((item) => [item.label, item.state])).toEqual([["Mini", "unsupported"]])
    expect(summary?.hosts.map((item) => item.cost)).toEqual([40, 25])
  })

  test("setup snapshot 2026-10-28T10:20:37Z (offset -240): two installed older Cores give no combined total", () => {
    const at = "2026-10-28T10:20:37Z"
    const summary = costSummary([laptop, mini], {
      laptop: { value: olderRollup(594.78, at), readAt: NOW },
      mini: { value: olderRollup(541.65, at), readAt: NOW },
    }, NOW)
    expect(summary?.total).toBeUndefined()
    expect(summary?.hosts.map((item) => [item.label, item.state, item.cost])).toEqual([["Laptop", "unsupported", 594.78], ["Mini", "unsupported", 541.65]])
  })

  test("a host whose last read failed keeps its last origin value, still combines, and marks the summary partial", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(40), readAt: NOW },
      mini: { value: originRollup(25), error: "HTTP 503", readAt: NOW },
    }, NOW)
    expect(summary?.total).toBe(65)
    expect(summary?.partial).toBe(true)
    expect(summary?.hosts[1]).toMatchObject({ state: "offline", cost: 25, note: "last read failed: HTTP 503" })
  })

  test("a host never read (missing) leaves no combined total", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(40), readAt: NOW },
      mini: { error: "HTTP 503", readAt: NOW },
    }, NOW)
    expect(summary?.total).toBeUndefined()
    expect(summary?.gaps.map((item) => [item.label, item.state])).toEqual([["Mini", "unreachable"]])
  })

  test("an origin-only host with unpriced usage combines but is labelled partial", () => {
    const summary = costSummary([laptop], {
      laptop: { value: originRollup(40, { unpricedModels: 1 }), readAt: NOW },
    }, NOW)
    expect(summary?.hosts[0]).toMatchObject({ state: "partial", cost: 40, note: "some usage unpriced or not yet counted" })
    expect(summary?.total).toBe(40)
    expect(summary?.partial).toBe(true)
  })

  test("a lone WORK host on an older Core is its own total", () => {
    const summary = costSummary([laptop], { laptop: { value: olderRollup(142), readAt: NOW } }, NOW)
    expect(summary?.total).toBe(142)
  })

  test("hides the summary rather than showing $0 when no host has a priced cost", () => {
    const summary = costSummary([laptop], {
      laptop: { value: originRollup(0, { cost: null, originCost: null }), readAt: NOW },
    }, NOW)
    expect(summary).toBeUndefined()
  })
})

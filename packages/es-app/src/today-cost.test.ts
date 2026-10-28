import { describe, expect, test } from "bun:test"
import type { UsageDaily } from "./api"
import { costSummary } from "./today-cost"

const NOW = Date.parse("2026-10-28T12:00:00Z")
const tokens = { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
const laptop = { id: "laptop", label: "Laptop", base: "", current: true }
const mini = { id: "mini", label: "Mini", base: "/hosts/mini", current: false }

const originRollup = (cost: number, extra: Partial<UsageDaily["days"][number]> = {}): UsageDaily => ({
  estimate: true, basis: "", host: "h", observedAt: new Date(NOW).toISOString(), offsetMinutes: 0,
  coverage: { scope: "", backfilled: true },
  days: [{ day: "2026-10-28", cost, complete: true, originOnly: true, originCost: cost, unpricedModels: 0,
    models: [{ provider: "a", model: "m", cost, coverage: "priced", tokens }], ...extra }],
  rateLimits: { source: "headers", providers: [] },
})

describe("costSummary", () => {
  test("sums origin-only costs of complete fresh hosts as exact", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(40), readAt: NOW },
      mini: { value: originRollup(25), readAt: NOW },
    }, NOW)
    expect(summary?.total).toBe(65)
    expect(summary?.partial).toBe(false)
    expect(summary?.hosts.map((item) => item.state)).toEqual(["ok", "ok"])
  })

  test("labels a host whose last read failed as offline, keeps its last value, and marks the total partial", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(40), readAt: NOW },
      mini: { value: originRollup(25), error: "HTTP 503", readAt: NOW },
    }, NOW)
    expect(summary?.total).toBe(65)
    expect(summary?.partial).toBe(true)
    expect(summary?.hosts[1]).toMatchObject({ state: "offline", cost: 25, note: "last read failed: HTTP 503" })
  })

  test("labels an origin-only host with unpriced usage as partial, not unpriced", () => {
    const summary = costSummary([laptop], {
      laptop: { value: originRollup(40, { unpricedModels: 1 }), readAt: NOW },
    }, NOW)
    expect(summary?.hosts[0]).toMatchObject({ state: "partial", cost: 40, note: "some usage unpriced or not yet counted" })
    expect(summary?.partial).toBe(true)
  })

  test("never sums an older Core's raw daily cost from another host", () => {
    const raw = { ...originRollup(25), days: [{ day: "2026-10-28", cost: 25, models: [{ provider: "a", model: "m", cost: 25, tokens }] }] }
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(40), readAt: NOW },
      mini: { value: raw, readAt: NOW },
    }, NOW)
    expect(summary?.total).toBe(40)
    expect(summary?.counted).toEqual(["laptop"])
    expect(summary?.hosts[1]?.state).toBe("overlap")
  })

  test("hides the total rather than showing $0 when no host has a priced cost", () => {
    const summary = costSummary([laptop], {
      laptop: { value: originRollup(0, { cost: null, originCost: null }), readAt: NOW },
    }, NOW)
    expect(summary).toBeUndefined()
  })
})

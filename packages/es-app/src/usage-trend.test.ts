import { describe, expect, test } from "bun:test"
import type { UsageDaily } from "./api"
import { buildTrend, groupByDirectory, OTHER } from "./usage-trend"

const tokens = (input: number, output: number, read = 0, write = 0) => ({ input, output, reasoning: 0, cache: { read, write } })
const model = (name: string, cost: number | null, coverage: "priced" | "missing-rate" | "local" = "priced", t = tokens(1000, 100)) =>
  ({ provider: "p", model: name, cost, coverage, tokens: t })

const usage = (days: UsageDaily["days"], coverage: Partial<UsageDaily["coverage"]> = {}): UsageDaily => ({
  estimate: true,
  basis: "estimate",
  host: "local",
  observedAt: "2026-10-28T12:00:00Z",
  offsetMinutes: 0,
  coverage: { scope: "this host", backfilled: true, ...coverage },
  // Core returns newest first.
  days,
  rateLimits: { source: "", providers: [] },
})

describe("buildTrend", () => {
  test("orders days oldest first and keeps only the window", () => {
    const trend = buildTrend(usage([
      { day: "2026-10-28", complete: true, cost: 1, models: [model("a", 1)] },
      { day: "2026-10-27", complete: true, cost: 2, models: [model("a", 2)] },
      { day: "2026-10-26", complete: true, cost: 3, models: [model("a", 3)] },
    ]), 2, "2026-10-28")
    expect(trend.days.map((day) => day.day)).toEqual(["2026-10-27", "2026-10-28"])
    expect(trend.total).toBe(3)
  })

  test("a day with usage but no price is unknown, not zero", () => {
    const trend = buildTrend(usage([
      { day: "2026-10-27", complete: true, cost: null, models: [model("gateway", null, "missing-rate")] },
    ]), 7, "2026-10-28")
    expect(trend.days[0]).toMatchObject({ state: "unpriced", cost: null })
    expect(trend.exact).toBe(false)
    expect(trend.models[0].unpriced).toBe(true)
  })

  test("zero cost with tokens on an old Core counts as unpriced", () => {
    const trend = buildTrend(usage([
      { day: "2026-10-27", cost: 5, models: [{ provider: "p", model: "x", cost: 0, tokens: tokens(500, 50) }, { provider: "p", model: "y", cost: 5, tokens: tokens(9, 9) }] },
    ]), 7, "2026-10-28")
    expect(trend.days[0].state).toBe("partly-priced")
    expect(trend.models.find((m) => m.model === "x")?.unpriced).toBe(true)
  })

  test("local inference is free, not unpriced", () => {
    const trend = buildTrend(usage([
      { day: "2026-10-27", complete: true, cost: 0, models: [model("llama", 0, "local")] },
    ]), 7, "2026-10-28")
    expect(trend.days[0].state).toBe("complete")
    expect(trend.models[0]).toMatchObject({ local: true, unpriced: false })
  })

  test("days before counting started are incomplete when the rollup was not backfilled", () => {
    const trend = buildTrend(usage([
      { day: "2026-10-28", cost: 4, models: [model("a", 4)] },
      { day: "2026-10-27", cost: 1, models: [model("a", 1)] },
      { day: "2026-10-26", cost: 0, models: [] },
    ], { backfilled: false, liveSince: "2026-10-27T15:00:00Z" }), 3, "2026-10-28")
    expect(trend.days.map((day) => day.state)).toEqual(["incomplete", "incomplete", "today"])
    expect(trend.gaps).toBe(2)
  })

  test("an explicit incomplete flag wins and an empty covered day is idle", () => {
    const trend = buildTrend(usage([
      { day: "2026-10-28", complete: false, cost: 1, models: [model("a", 1)] },
      { day: "2026-10-27", complete: true, cost: 0, models: [] },
    ]), 7, "2026-10-28")
    expect(trend.days.map((day) => day.state)).toEqual(["idle", "incomplete"])
  })

  test("stacks the top five models and groups the rest as other", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"]
    const trend = buildTrend(usage([
      { day: "2026-10-27", complete: true, cost: 28, models: names.map((name, index) => model(name, 7 - index)) },
    ]), 7, "2026-10-28")
    expect(trend.series).toEqual(["p/a", "p/b", "p/c", "p/d", "p/e", OTHER])
    expect(trend.days[0].parts[OTHER]).toBe(2 + 1)
    expect(trend.models[0].share).toBeCloseTo(7 / 28)
  })

  test("cuts quote real numbers and stay silent without spend", () => {
    const trend = buildTrend(usage([
      { day: "2026-10-27", complete: true, cost: 30, models: [model("opus", 27, "priced", tokens(0, 10, 900, 100)), model("sol", 3)] },
      { day: "2026-10-26", complete: true, cost: 4, models: [model("opus", 4)] },
      { day: "2026-10-25", complete: true, cost: 5, models: [model("opus", 5)] },
    ]), 7, "2026-10-28")
    expect(trend.cuts.map((cut) => cut.id)).toEqual(["top-model", "cache-write", "peak-day"])
    expect(trend.cuts[0].title).toContain("92%")
    expect(trend.cuts[2].title).toContain("2026-10-27")
    expect(buildTrend(usage([{ day: "2026-10-27", complete: true, cost: 0, models: [] }]), 7, "2026-10-28").cuts).toEqual([])
  })
})

describe("groupByDirectory", () => {
  const session = (sessionID: string, directory: string | undefined, pricedCost: number, cost: number | null = pricedCost) =>
    ({ sessionID, directory, pricedCost, cost, unpricedTokens: cost == null ? 10 : 0 })
  test("groups editspace lanes by lane root and plain directories by path, most expensive first", () => {
    const { groups, partial } = groupByDirectory([
      session("a", "/u/opencode/.editspace/lanes/es-app/repos/o/r", 10),
      session("b", "/u/opencode/.editspace/lanes/es-app", 5),
      session("c", "/u/editspaces/wb/lanes/batch/repos/o/r", 20),
      session("d", "/u/projects/thing", 3, null),
      session("e", undefined, 1),
    ], 200)
    expect(groups.map((g) => [g.label, g.kind, g.pricedCost, g.sessions])).toEqual([
      ["batch", "lane", 20, 1], ["es-app", "lane", 15, 2], ["projects/thing", "directory", 3, 1], ["unknown directory", "unknown", 1, 1],
    ])
    expect(groups[2].unpriced).toBe(true)
    expect(partial).toBe(false)
  })
  test("a lanes folder outside an editspace is just a directory, and a full page is partial", () => {
    const { groups, partial } = groupByDirectory([session("a", "/srv/lanes/x/app", 2), session("b", "/srv/lanes/x/app", 2)], 2)
    expect(groups[0]).toMatchObject({ kind: "directory", label: "x/app" })
    expect(partial).toBe(true)
  })
})

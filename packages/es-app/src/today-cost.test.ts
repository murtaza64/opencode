import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { UsageDaily } from "./api"
import { costSummary, nextLocalMidnight } from "./today-cost"

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

  test("activated Core on a cutoff day (coverage.origin, originOnly false, originCost null) is tracking, not unsupported", () => {
    const cutoff = (cost: number): UsageDaily => ({ ...originRollup(cost, { originOnly: false, originCost: null }),
      coverage: { scope: "", backfilled: true, origin: { basis: "step", hostID: "h", originSince: "2026-10-28T14:10:00Z" } } })
    const summary = costSummary([laptop, mini], {
      laptop: { value: cutoff(594.78), readAt: NOW },
      mini: { value: cutoff(541.65), readAt: NOW },
    }, NOW)
    expect(summary?.total).toBeUndefined()
    expect(summary?.partial).toBe(true)
    expect(summary?.hosts.map((item) => item.state)).toEqual(["tracking", "tracking"])
    expect(summary?.hosts[0]?.note).toContain("origin tracked since")
    expect(summary?.hosts[0]?.note).not.toContain("Core has no origin-only cost")
  })

  // dotfiles#264 real cutoff-day reads, 2026-10-29T02:39:5xZ, offset -240.
  const cutoffDay = (host: string, raw: number, originSince: string, partial: UsageDaily["days"][number]["originPartial"]): UsageDaily => ({
    estimate: true, basis: "", host, observedAt: new Date(NOW).toISOString(), offsetMinutes: -240,
    coverage: { scope: "", backfilled: true, origin: { basis: "step", hostID: host, originSince } },
    days: [{ day: "2026-10-28", cost: raw, complete: true, originOnly: false, originCost: null, unpricedModels: 0, originPartial: partial,
      models: [{ provider: "a", model: "m", cost: raw, coverage: "priced", tokens }] }],
    rateLimits: { source: "headers", providers: [] },
  })

  test("cutoff day with the same origin start on both hosts: one subtotal since that hour, raw daily never summed", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: cutoffDay("laptop", 932.407715, "2026-10-28T15:37:35.803Z", { since: "2026-10-28T16:00:00Z", cost: 310.5, unpricedModels: 0 }), readAt: NOW },
      mini: { value: cutoffDay("mini", 1660.150433, "2026-10-28T15:48:32.651Z", { since: "2026-10-28T16:00:00Z", cost: 420.25, unpricedModels: 0 }), readAt: NOW },
    }, NOW)
    expect(summary?.total).toBeUndefined()
    expect(summary?.subtotal).toEqual({ since: Date.parse("2026-10-28T16:00:00Z"), cost: 730.75, unpriced: false,
      hosts: [{ id: "laptop", cost: 310.5, unpriced: false }, { id: "mini", cost: 420.25, unpriced: false }] })
    expect(summary?.partial).toBe(true)
    expect(summary?.subtotal?.cost).not.toBe(932.407715 + 1660.150433)
  })

  test("different origin starts are not comparable: no subtotal", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: cutoffDay("laptop", 932, "2026-10-28T15:37:35Z", { since: "2026-10-28T16:00:00Z", cost: 300, unpricedModels: 0 }), readAt: NOW },
      mini: { value: cutoffDay("mini", 1660, "2026-10-28T16:10:00Z", { since: "2026-10-28T17:00:00Z", cost: 400, unpricedModels: 0 }), readAt: NOW },
    }, NOW)
    expect(summary?.subtotal).toBeUndefined()
  })

  test("a host without the partial field (pre-#264 Core) blocks the subtotal", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: cutoffDay("laptop", 932, "2026-10-28T15:37:35Z", { since: "2026-10-28T16:00:00Z", cost: 300, unpricedModels: 0 }), readAt: NOW },
      mini: { value: cutoffDay("mini", 1660, "2026-10-28T15:48:32Z", undefined), readAt: NOW },
    }, NOW)
    expect(summary?.subtotal).toBeUndefined()
    expect(summary?.gaps.map((item) => item.state)).toEqual(["tracking", "tracking"])
  })

  test("unpriced usage inside the window is reported, and a zero subtotal stays a measured zero", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: cutoffDay("laptop", 10, "2026-10-28T15:37:35Z", { since: "2026-10-28T16:00:00Z", cost: 0, unpricedModels: 1 }), readAt: NOW },
      mini: { value: cutoffDay("mini", 10, "2026-10-28T15:48:32Z", { since: "2026-10-28T16:00:00Z", cost: 0, unpricedModels: 0 }), readAt: NOW },
    }, NOW)
    expect(summary?.subtotal).toMatchObject({ cost: 0, unpriced: true })
  })

  test("an unreachable host blocks the subtotal", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: cutoffDay("laptop", 932, "2026-10-28T15:37:35Z", { since: "2026-10-28T16:00:00Z", cost: 300, unpricedModels: 0 }), readAt: NOW },
      mini: { error: "HTTP 503", readAt: NOW },
    }, NOW)
    expect(summary?.subtotal).toBeUndefined()
  })

  test("the next local day: both hosts whole-day origin-only give the complete total and no subtotal", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(120), readAt: NOW },
      mini: { value: originRollup(80), readAt: NOW },
    }, NOW)
    expect([summary?.total, summary?.subtotal]).toEqual([200, undefined])
  })

  test("an older Core without origin fields or coverage.origin stays unsupported", () => {
    const summary = costSummary([laptop, mini], {
      laptop: { value: originRollup(40), readAt: NOW },
      mini: { value: olderRollup(25), readAt: NOW },
    }, NOW)
    expect(summary?.hosts[1]).toMatchObject({ state: "unsupported", note: "Core has no origin-only cost" })
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

// New York, west of UTC: 00:00Z is still the previous local day (DD .03.12, Porter #1231).
describe("local day", () => {
  const zone = process.env.TZ
  beforeAll(() => { process.env.TZ = "America/New_York" })
  afterAll(() => { process.env.TZ = zone })
  const nov3 = (cost: number): UsageDaily => ({ ...originRollup(cost, { day: "2026-11-03" }), offsetMinutes: -300 })

  test("after 00:00Z but before local midnight, today's total is unchanged", () => {
    const summary = costSummary([laptop], { laptop: { value: nov3(142), readAt: Date.parse("2026-11-03T23:50:00Z") } }, Date.parse("2026-11-04T00:30:00Z"))
    expect(summary?.total).toBe(142)
  })

  test("after local midnight, yesterday's reading is not today's total and is not shown as 0", () => {
    const summary = costSummary([laptop], { laptop: { value: nov3(142), readAt: Date.parse("2026-11-04T04:50:00Z") } }, Date.parse("2026-11-04T05:00:30Z"))
    expect(summary).toBeUndefined()
  })

  test("with two hosts, one still on yesterday's reading leaves no combined total and says why", () => {
    const now = Date.parse("2026-11-04T05:01:00Z")
    const nov4 = (cost: number): UsageDaily => ({ ...originRollup(cost, { day: "2026-11-04" }), offsetMinutes: -300 })
    const summary = costSummary([laptop, mini], { laptop: { value: nov4(3), readAt: now }, mini: { value: nov3(90), readAt: now } }, now)
    expect(summary?.total).toBeUndefined()
    expect(summary?.hosts.map((item) => [item.label, item.state, item.cost])).toEqual([["Laptop", "ok", 3], ["Mini", "stale", undefined]])
    expect(summary?.hosts[1]?.note).toBe("last reading is for 2026-11-03")
  })

  test("each host records the offset it was asked for", () => {
    const summary = costSummary([laptop], { laptop: { value: nov3(142), readAt: Date.parse("2026-11-03T18:00:00Z") } }, Date.parse("2026-11-03T18:00:00Z"))
    expect(summary?.hosts[0]?.offsetMinutes).toBe(-300)
  })

  test("the re-read is scheduled just after the next local midnight, not 00:00Z", () => {
    expect(new Date(nextLocalMidnight(Date.parse("2026-11-03T23:30:00Z"))).toISOString()).toBe("2026-11-04T05:00:05.000Z")
  })

  test("on the DST change the local day is 25 hours long and the re-read follows local midnight", () => {
    // Nov 1 2026: clocks go back at 2 AM EDT; local midnight Nov 2 is 05:00Z.
    expect(new Date(nextLocalMidnight(Date.parse("2026-11-01T04:30:00Z"))).toISOString()).toBe("2026-11-02T05:00:05.000Z")
  })
})

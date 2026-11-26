import { describe, expect, test } from "bun:test"
import type { OpenRouterUsage, UsageDaily } from "./api"
import { combineSpend, periodStart, type OriReading, type Reading } from "./today-cost"

// Friday 2026-11-20 12:00Z: the week began Monday 11-16, the month 11-01.
const NOW = Date.parse("2026-11-20T12:00:00Z")
const tokens = { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
const laptop = { id: "laptop", label: "Laptop", base: "", current: true }
const mini = { id: "mini", label: "Mini", base: "/hosts/mini", current: false }

const day = (offset: number) => new Date(Date.parse("2026-11-20T00:00:00Z") - offset * 86_400_000).toISOString().slice(0, 10)
/** A UTC rollup with `gateway` per day on a duolingo provider and `openrouter` per day on openrouter. */
const ledger = (gateway: number, openrouter = 0, extra: Partial<UsageDaily["days"][number]> = {}, days = 31): Reading => ({
  readAt: NOW,
  value: {
    estimate: true, basis: "", host: "h", observedAt: new Date(NOW).toISOString(), offsetMinutes: 0,
    coverage: { scope: "", backfilled: true },
    days: Array.from({ length: days }, (_, index) => ({
      day: day(index), cost: gateway + openrouter, complete: true, originOnly: true, originCost: gateway + openrouter, unpricedModels: 0,
      models: [
        { provider: "duolingo-anthropic", model: "m", cost: gateway, coverage: "priced" as const, tokens },
        { provider: "openrouter", model: "auto", cost: openrouter, coverage: "priced" as const, tokens },
      ],
      ...extra,
    })),
    rateLimits: { source: "headers", providers: [] },
  },
})
const ori = (today: number, week: number, month: number, extra: Partial<OpenRouterUsage> = {}): OriReading => ({
  readAt: NOW,
  value: {
    schema: "es-openrouter-usage/1", state: "ok", observedAt: new Date(NOW).toISOString(), key_id: "0123456789abcdef",
    credits_today_utc_usd: 0, external_byok_today_utc_usd: today,
    credits_week_utc_usd: 0, external_byok_week_utc_usd: week,
    credits_month_utc_usd: 0, external_byok_month_utc_usd: month,
    ...extra,
  },
})

describe("combineSpend", () => {
  test("sums OpenRouter billing and each host's ledger without its openrouter rows, per UTC period", () => {
    const result = combineSpend([laptop], { laptop: ledger(2, 50) }, { laptop: ori(100, 300, 900) }, NOW)
    // Ledger: 2/day; 5 days since Monday; 20 days since the 1st. Openrouter rows (50/day) are the same spend as billing.
    expect(result.periods.today).toEqual({ amount: 102, partial: false, gaps: [] })
    expect(result.periods.week).toEqual({ amount: 310, partial: false, gaps: [] })
    expect(result.periods.month).toEqual({ amount: 940, partial: false, gaps: [] })
  })

  test("Mini unreachable: the known amounts still show, partial, naming Mini", () => {
    const result = combineSpend([laptop, mini],
      { laptop: ledger(2), mini: { error: "HTTP 502", readAt: NOW } },
      { laptop: ori(100, 300, 900), mini: { error: "HTTP 502", readAt: NOW } }, NOW)
    expect(result.periods.today.amount).toBe(102)
    expect(result.periods.today.partial).toBe(true)
    expect(result.periods.today.gaps).toEqual(["Mini OpenRouter: HTTP 502", "Mini Core: HTTP 502"])
  })

  test("hosts sharing one OpenRouter key count it once, using the freshest reading", () => {
    const older = ori(90, 290, 890, { observedAt: new Date(NOW - 60_000).toISOString() })
    const result = combineSpend([laptop, mini], { laptop: ledger(0), mini: ledger(0) }, { laptop: ori(100, 300, 900), mini: older }, NOW)
    expect(result.periods.today).toEqual({ amount: 100, partial: false, gaps: [] })
  })

  test("different keys are both counted", () => {
    const result = combineSpend([laptop, mini], { laptop: ledger(0), mini: ledger(0) },
      { laptop: ori(100, 300, 900), mini: ori(5, 6, 7, { key_id: "fedcba9876543210" }) }, NOW)
    expect(result.periods.month.amount).toBe(907)
  })

  test("an older dashboard: no key id is not counted beside another key; no week figure is a gap, not $0", () => {
    const legacy = ori(5, 0, 0, { key_id: undefined, credits_week_utc_usd: undefined, external_byok_week_utc_usd: undefined })
    const result = combineSpend([laptop, mini], { laptop: ledger(0), mini: ledger(0) }, { laptop: ori(100, 300, 900), mini: legacy }, NOW)
    expect(result.periods.today.amount).toBe(100)
    expect(result.periods.today.gaps).toEqual(["Mini OpenRouter: key not identified, so it may duplicate another host's; not counted"])
    expect(result.periods.week.gaps).toEqual(["Mini OpenRouter: week to date not reported"])
  })

  test("a lone legacy reading is counted for today and unknown for the week", () => {
    const legacy = ori(5, 0, 0, { key_id: undefined, credits_week_utc_usd: undefined, external_byok_week_utc_usd: undefined, credits_month_utc_usd: undefined, external_byok_month_utc_usd: undefined })
    const result = combineSpend([laptop], { laptop: { error: "HTTP 500", readAt: NOW } }, { laptop: legacy }, NOW)
    expect(result.periods.today.amount).toBe(5)
    expect(result.periods.week.amount).toBeUndefined()
    expect(result.periods.month.amount).toBeUndefined()
  })

  test("nothing known: no amount, never $0", () => {
    const result = combineSpend([laptop], {}, {}, NOW)
    expect(result.periods.today.amount).toBeUndefined()
    expect(result.periods.today.gaps).toEqual(["Laptop OpenRouter: not read yet", "Laptop Core: not read yet"])
  })

  test("with several hosts a day not yet split by host leaves that host out of the period", () => {
    const result = combineSpend([laptop, mini], { laptop: ledger(2), mini: ledger(3, 0, { originOnly: false }) }, { laptop: ori(0, 0, 0) }, NOW)
    expect(result.periods.today.amount).toBe(2)
    expect(result.periods.today.gaps).toContain("Mini Core: some days not yet split by host")
  })

  test("a Core reading from yesterday is not today's and leaves the host out", () => {
    const stale = ledger(4)
    stale.value!.days = stale.value!.days.slice(1)
    const result = combineSpend([laptop], { laptop: stale }, { laptop: ori(1, 1, 1) }, NOW)
    expect(result.periods.today.amount).toBe(1)
    expect(result.periods.today.gaps).toEqual(["Laptop Core: last reading is for 2026-11-19"])
  })

  test("an OpenRouter reading from last month is not this month's", () => {
    const result = combineSpend([laptop], { laptop: ledger(0) }, { laptop: ori(1, 1, 1, { observedAt: "2026-10-31T23:59:00Z" }) }, NOW)
    expect(result.periods.month.gaps).toEqual(["Laptop OpenRouter: last reading is from an earlier month"])
  })

  test("unpriced usage keeps the period partial", () => {
    const reading = ledger(2)
    reading.value!.days[0]!.models.push({ provider: "duolingo-openai", model: "new", cost: null, coverage: "missing-rate", tokens })
    const result = combineSpend([laptop], { laptop: reading }, { laptop: ori(0, 0, 0) }, NOW)
    expect(result.periods.today).toEqual({ amount: 2, partial: true, gaps: ["Laptop Core: some usage has no price"] })
  })
})

describe("periodStart", () => {
  test("week starts Monday 00:00 UTC, also on a Sunday and a Monday", () => {
    expect(new Date(periodStart("week", Date.parse("2026-11-22T23:59:00Z"))).toISOString()).toBe("2026-11-16T00:00:00.000Z")
    expect(new Date(periodStart("week", Date.parse("2026-11-23T00:00:00Z"))).toISOString()).toBe("2026-11-23T00:00:00.000Z")
  })

  test("month to date starts on the 1st; a week can span two months", () => {
    const now = Date.parse("2026-12-02T08:00:00Z")
    expect(new Date(periodStart("month", now)).toISOString()).toBe("2026-12-01T00:00:00.000Z")
    expect(new Date(periodStart("week", now)).toISOString()).toBe("2026-11-30T00:00:00.000Z")
  })

  test("the week spanning months reads the previous month's days from the ledger", () => {
    const now = Date.parse("2026-12-02T08:00:00Z")
    const reading = ledger(1)
    reading.value!.days = reading.value!.days.map((item, index) => ({ ...item, day: new Date(Date.parse("2026-12-02T00:00:00Z") - index * 86_400_000).toISOString().slice(0, 10) }))
    reading.value!.observedAt = new Date(now).toISOString()
    const result = combineSpend([laptop], { laptop: reading }, { laptop: ori(0, 0, 0, { observedAt: new Date(now).toISOString() }) }, now)
    expect(result.periods.week.amount).toBe(3)
    expect(result.periods.month.amount).toBe(2)
  })
})

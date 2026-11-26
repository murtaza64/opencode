/* Combined AI spend across the WORK hosts for the title bar: Today, week to date and month to date, in UTC
 * (COST-01; dedupe contract from runtime-lag c85be002). Each WORK host is read through this listener (this
 * host directly, others at /hosts/<id>/): once when first shown, then after a turn finishes or the tab
 * returns, at most once a minute per host. No polling.
 * Two sources per host: the OpenRouter key's billing (credits + BYOK), counted once per key across hosts,
 * and the Core ledger's origin-only cost (steps that host ran) without its openrouter rows, which are the
 * same spend as the key billing. A host or source that cannot say (unreachable, older Core or dashboard,
 * day not wholly origin-attributed, unpriced models) makes the period partial and is named in the tooltip;
 * it never blocks or zeroes the others. Personal is not a WORK host and is never read. */
import { createSignal } from "solid-js"
import { es, oc, type OpenRouterUsage, type UsageDaily } from "./api"
import { host, readHost } from "./host"
import { background } from "./startup"

const MIN_GAP_MS = 60_000
export const STALE_MS = 15 * 60_000
const DAY_MS = 86_400_000
/** Enough UTC days for month to date (the Core serves at most 90). */
const LEDGER_DAYS = 31

export type Target = { id: string; label: string; base: string; current: boolean }
export type Reading = { value?: UsageDaily; error?: string; readAt: number }
/** `undefined` value: the host's dashboard has no billing route. */
export type OriReading = { value?: OpenRouterUsage; error?: string; readAt: number }

const [readings, setReadings] = createSignal<Record<string, Reading>>({})
const [oriReadings, setOriReadings] = createSignal<Record<string, OriReading>>({})
const [targets, setTargets] = createSignal<Target[]>([])
let oriLast = 0
let oriInflight: Promise<void> | undefined
let oriTimer: ReturnType<typeof setTimeout> | undefined
const last = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()
let timer: ReturnType<typeof setTimeout> | undefined
let midnight: ReturnType<typeof setTimeout> | undefined
let started = false

/** This host when it is a WORK host (or the only host known), plus every other WORK host. */
const workTargets = (): Target[] => {
  const info = host()
  if (info?.profile === "personal") return []
  if (!info) return [{ id: "local", label: "This host", base: "", current: true }]
  if (!info.work.length) return [{ id: info.id, label: info.label, base: "", current: true }]
  return [
    ...(info.work.some((item) => item.id === info.id) ? [{ id: info.id, label: info.label, base: "", current: true }] : []),
    ...info.work.filter((item) => item.id !== info.id).map((item) => ({ id: item.id, label: item.label, base: `/hosts/${item.id}`, current: false })),
  ]
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

const read = (target: Target) => {
  const running = inflight.get(target.id)
  if (running) return running
  last.set(target.id, Date.now())
  const promise = (async () => {
    try {
      const value = await background(() => oc.usageDaily(LEDGER_DAYS, AbortSignal.timeout(15_000), target.base, 0))
      setReadings((previous) => ({ ...previous, [target.id]: value ? { value, readAt: Date.now() } : { ...previous[target.id], error: "usage not available", readAt: Date.now() } }))
    } catch (cause) {
      // Keep the last value (it turns stale); the error names why this host is not current.
      setReadings((previous) => ({ ...previous, [target.id]: { ...previous[target.id], error: message(cause), readAt: Date.now() } }))
    } finally {
      inflight.delete(target.id)
    }
  })()
  inflight.set(target.id, promise)
  return promise
}

const readOri = () => {
  if (oriInflight) return oriInflight
  oriLast = Date.now()
  oriInflight = Promise.all(targets().map(async target => {
    const result = await background(() => es.openrouterUsage(AbortSignal.timeout(55_000), target.base))
      .then(value => ({ value }), (cause: unknown) => ({ error: message(cause) }))
    setOriReadings(previous => {
      const kept = previous[target.id]?.value?.state === "ok" ? previous[target.id]!.value : undefined
      const next: OriReading = "error" in result
        ? { value: kept, error: result.error, readAt: Date.now() }
        : result.value?.state === "unavailable" && kept
          ? { value: kept, error: result.value.reason ?? "billing unavailable", readAt: Date.now() }
          : { value: result.value, readAt: Date.now() }
      return { ...previous, [target.id]: next }
    })
  }))
    .then(() => { oriInflight = undefined })
  return oriInflight
}

export type Period = "today" | "week" | "month"
export const PERIODS: { id: Period; label: string; name: string }[] = [
  { id: "today", label: "Today", name: "today" },
  { id: "week", label: "WTD", name: "week to date" },
  { id: "month", label: "MTD", name: "month to date" },
]
const ORI_FIELDS = {
  today: ["credits_today_utc_usd", "external_byok_today_utc_usd"],
  week: ["credits_week_utc_usd", "external_byok_week_utc_usd"],
  month: ["credits_month_utc_usd", "external_byok_month_utc_usd"],
} as const

/** UTC start of each period: the day, the week from Monday 00:00 (OpenRouter's week), the calendar month. */
export const periodStart = (period: Period, now: number) => {
  const at = new Date(now)
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  if (period === "today") return day
  if (period === "week") return day - ((at.getUTCDay() + 6) % 7) * DAY_MS
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)
}

export const spendTotals = (now = Date.now()) => combineSpend(targets(), readings(), oriReadings(), now)

export type PeriodSpend = { amount?: number; partial: boolean; gaps: string[] }

/** One known-so-far amount per UTC period across every WORK host. A period with nothing known has no amount
 * (never $0); one with any gap is partial and lists it. */
export const combineSpend = (targets: Target[], readings: Record<string, Reading>, ori: Record<string, OriReading>, now: number) => {
  const periods = Object.fromEntries(PERIODS.map(({ id }): [Period, PeriodSpend] => {
    const start = periodStart(id, now)
    const gaps: string[] = []
    const parts = [...oriParts(targets, ori, id, start, now, gaps), ...ledgerParts(targets, readings, start, now, gaps)]
    return [id, { amount: parts.length ? parts.reduce((sum, amount) => sum + amount, 0) : undefined, partial: gaps.length > 0, gaps }]
  })) as Record<Period, PeriodSpend>
  const observed = Object.values(readings).flatMap(reading => reading.value ? [Date.parse(reading.value.observedAt)] : [])
    .concat(Object.values(ori).flatMap(reading => reading.value?.observedAt ? [Date.parse(reading.value.observedAt)] : []))
    .filter(Number.isFinite)
  return { periods, observedAt: observed.length ? Math.min(...observed) : undefined }
}

/** Each OpenRouter key's amount once (the freshest reading of it). A reading that cannot name its key is
 * counted only when it is the sole reading, since two unnamed readings may be one key. */
const oriParts = (targets: Target[], ori: Record<string, OriReading>, period: Period, start: number, now: number, gaps: string[]) => {
  const known = targets.flatMap(target => {
    const reading = ori[target.id]
    const value = reading?.value
    if (!reading) return gaps.push(`${target.label} OpenRouter: not read yet`), []
    if (value?.state === "not-configured") return []
    if (!value) return gaps.push(`${target.label} OpenRouter: ${reading.error ?? "not reported by this host"}`), []
    if (value.state !== "ok") return gaps.push(`${target.label} OpenRouter: ${value.reason ?? "unavailable"}`), []
    const observedAt = Date.parse(value.observedAt ?? "")
    const [credits, byok] = ORI_FIELDS[period].map(field => value[field])
    // A reading from before this period started is another period's figure.
    if (!Number.isFinite(observedAt) || observedAt < start) return gaps.push(`${target.label} OpenRouter: last reading is from an earlier ${period === "today" ? "day" : period}`), []
    if (!amount(credits) || !amount(byok)) return gaps.push(`${target.label} OpenRouter: ${period === "today" ? "" : `${period} to date `}not reported`), []
    if (reading.error) gaps.push(`${target.label} OpenRouter: last read failed (${reading.error}); showing ${age(observedAt, now)} reading`)
    return [{ key: value.key_id ?? undefined, label: target.label, observedAt, total: credits + byok }]
  })
  const unnamed = known.filter(item => !item.key)
  if (unnamed.length && known.length > 1) unnamed.forEach(item => gaps.push(`${item.label} OpenRouter: key not identified, so it may duplicate another host's; not counted`))
  const counted = known.length === 1 ? known : known.filter(item => item.key)
  const freshest = new Map<string, (typeof counted)[number]>()
  counted.forEach(item => {
    const seen = freshest.get(item.key ?? "")
    if (!seen || item.observedAt > seen.observedAt) freshest.set(item.key ?? "", item)
  })
  return [...freshest.values()].map(item => item.total)
}

/** Each host's ledger for the UTC days from `start` through today, without openrouter rows. With several hosts
 * only origin-only days count (a host's other days may include history moved from another host); a lone
 * host's own cost has nothing to overlap. */
const ledgerParts = (targets: Target[], readings: Record<string, Reading>, start: number, now: number, gaps: string[]) =>
  targets.flatMap(target => {
    const reading = readings[target.id]
    const value = reading?.value
    if (!reading) return gaps.push(`${target.label} Core: not read yet`), []
    if (!value) return gaps.push(`${target.label} Core: ${reading.error ?? "unreachable"}`), []
    if (value.offsetMinutes !== 0) return gaps.push(`${target.label} Core: not bucketed by UTC day`), []
    const today = new Date(now).toISOString().slice(0, 10)
    if (value.days[0]?.day !== today) return gaps.push(`${target.label} Core: last reading is for ${value.days[0]?.day ?? "another day"}`), []
    const wanted = Array.from({ length: Math.round((periodStart("today", now) - start) / DAY_MS) + 1 }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10))
    const days = wanted.map(day => value.days.find(item => item.day === day))
    if (days.some(day => !day)) return gaps.push(`${target.label} Core: some days not reported`), []
    if (targets.length > 1 && days.some(day => !day!.originOnly)) return gaps.push(`${target.label} Core: some days not yet split by host`), []
    if (days.some(day => day!.complete === false)) gaps.push(`${target.label} Core: some usage not yet counted`)
    const rows = days.flatMap(day => day!.models).filter(model => model.provider !== "openrouter" && model.coverage !== "no-usage")
    if (rows.some(unpriced)) gaps.push(`${target.label} Core: some usage has no price`)
    if (reading.error) gaps.push(`${target.label} Core: last read failed (${reading.error}); showing ${age(Date.parse(value.observedAt), now)} reading`)
    return [rows.reduce((sum, model) => sum + (model.cost ?? 0), 0)]
  })

const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

const age = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000)
  return !Number.isFinite(minutes) ? "an earlier" : minutes < 1 ? "a current" : `a ${minutes}-minute-old`
}

/** Starts the first reads; later calls do nothing. */
export const startTodayCost = () => {
  if (started) return
  started = true
  void readHost().then(() => {
    setTargets(workTargets())
    void readOri()
    targets().forEach((target) => void read(target))
    armMidnight()
  })
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") touchTodayCost() })
}

/** Re-reads both sources after UTC midnight, when a period may start. */
const armMidnight = () => {
  clearTimeout(midnight)
  midnight = setTimeout(() => {
    targets().forEach((target) => void read(target))
    void readOri()
    armMidnight()
  }, Math.max(0, (Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS + 5000 - Date.now()))
}

/** Something may have added spend: re-read each host, at most once a minute per host. */
export const touchTodayCost = () => {
  if (!started) return
  if (!oriTimer) oriTimer = setTimeout(() => {
    oriTimer = undefined
    void readOri()
  }, Math.max(0, oriLast + MIN_GAP_MS - Date.now()))
  if (timer || !targets().length) return
  const due = Math.min(...targets().map((target) => (last.get(target.id) ?? 0) + MIN_GAP_MS))
  timer = setTimeout(() => {
    timer = undefined
    targets().filter((target) => Date.now() - (last.get(target.id) ?? 0) >= MIN_GAP_MS - 50).forEach((target) => void read(target))
  }, Math.max(0, due - Date.now()))
}

/** A model with tokens but no price: older Cores report it as cost 0, newer ones as missing-rate. */
export const unpriced = (model: { cost: number | null; coverage?: string; tokens: { input: number; output: number; cache: { read: number } } }) =>
  model.coverage ? model.coverage === "missing-rate" : !model.cost && model.tokens.input + model.tokens.output + model.tokens.cache.read > 0

/** Visual bands from the recorded UX contract; not budget alarms. */
export const costBand = (total: number) => total >= 500 ? "high" : total >= 150 ? "mid" : "low"

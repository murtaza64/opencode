/* Today's estimated AI spend across the WORK hosts, for the title-bar badge (COST-01; ux-feel
 * contract DESK-AND-SIDEBARS.md; dedupe contract from runtime-lag c85be002). Each WORK host's rollup is
 * read through this listener (this host directly, others at /hosts/<id>/): once when first shown, then
 * after a turn finishes or the tab returns, at most once a minute per host. No polling.
 * The total sums each host's origin-only cost (steps that host ran), never its raw daily cost, which
 * can include history moved from another host. A host that cannot say (unreachable, older Core, day
 * not wholly origin-attributed, unpriced models) makes the total partial and is named in the tooltip;
 * it never blocks the others. Personal is not a WORK host and is never read. */
import { createSignal } from "solid-js"
import { oc, type UsageDaily } from "./api"
import { host, readHost } from "./host"
import { background } from "./startup"

const MIN_GAP_MS = 60_000
export const STALE_MS = 15 * 60_000

type Target = { id: string; label: string; base: string; current: boolean }
type Reading = { value?: UsageDaily; error?: string; readAt: number }

const [readings, setReadings] = createSignal<Record<string, Reading>>({})
const [targets, setTargets] = createSignal<Target[]>([])
const last = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()
let timer: ReturnType<typeof setTimeout> | undefined
let started = false

/** This host when it is a WORK host (or the only host known), plus every other WORK host. */
const workTargets = (): Target[] => {
  const info = host()
  if (!info) return [{ id: "local", label: "This host", base: "", current: true }]
  if (!info.work.length) return [{ id: info.id, label: info.label, base: "", current: true }]
  return [
    ...(info.work.some((item) => item.id === info.id) ? [{ id: info.id, label: info.label, base: "", current: true }] : []),
    ...info.work.filter((item) => item.id !== info.id).map((item) => ({ id: item.id, label: item.label, base: `/hosts/${item.id}`, current: false })),
  ]
}

const read = (target: Target) => {
  const running = inflight.get(target.id)
  if (running) return running
  last.set(target.id, Date.now())
  const promise = (async () => {
    try {
      const value = await background(() => oc.usageDaily(1, AbortSignal.timeout(15_000), target.base))
      setReadings((previous) => ({ ...previous, [target.id]: value ? { value, readAt: Date.now() } : { ...previous[target.id], error: "usage not available", readAt: Date.now() } }))
    } catch (cause) {
      // Keep the last value (it turns stale); the error names why this host is not current.
      setReadings((previous) => ({ ...previous, [target.id]: { ...previous[target.id], error: cause instanceof Error ? cause.message : String(cause), readAt: Date.now() } }))
    } finally {
      inflight.delete(target.id)
    }
  })()
  inflight.set(target.id, promise)
  return promise
}

/** Starts the first reads; later calls do nothing. */
export const startTodayCost = () => {
  if (started) return
  started = true
  void readHost().then(() => {
    setTargets(workTargets())
    targets().forEach((target) => void read(target))
  })
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") touchTodayCost() })
}

/** Something may have added spend: re-read each host, at most once a minute per host. */
export const touchTodayCost = () => {
  if (!started || timer || !targets().length) return
  const due = Math.min(...targets().map((target) => (last.get(target.id) ?? 0) + MIN_GAP_MS))
  timer = setTimeout(() => {
    timer = undefined
    targets().filter((target) => Date.now() - (last.get(target.id) ?? 0) >= MIN_GAP_MS - 50).forEach((target) => void read(target))
  }, Math.max(0, due - Date.now()))
}

export type HostCost = { id: string; label: string; current: boolean; state: "ok" | "unreachable" | "unpriced" | "overlap" | "pending"; cost?: number; observedAt?: number; note?: string }

export const todayCost = (now = Date.now()) => {
  const hosts: HostCost[] = targets().map((target) => {
    const reading = readings()[target.id]
    const value = reading?.value
    const today = value?.days[0]
    if (!reading) return { id: target.id, label: target.label, current: target.current, state: "pending" }
    if (!value || !today) return { id: target.id, label: target.label, current: target.current, state: "unreachable", note: reading.error }
    const observedAt = Date.parse(value.observedAt)
    const used = today.models.filter((model) => model.coverage !== "no-usage")
    const priced = used.filter((model) => !unpriced(model))
    const base = { id: target.id, label: target.label, current: target.current, observedAt }
    if (today.cost === null || (used.length && !priced.length)) return { ...base, state: "unpriced", note: "no priced usage" }
    const partial = !value.coverage.backfilled || today.complete === false || priced.length < used.length || (today.unpricedModels ?? 0) > 0
    // Origin-only when the Core says so; otherwise the raw daily cost, which may overlap another host.
    if (today.originOnly === true && typeof today.originCost === "number")
      return { ...base, state: partial || reading.error ? "unpriced" : "ok", cost: today.originCost, note: reading.error ? `last read failed: ${reading.error}` : partial ? "some usage unpriced or not yet counted" : undefined }
    return { ...base, state: "overlap", cost: today.cost, note: "may overlap another host (not origin-attributed)" }
  })
  // Sum origin-only costs. If none is available (older Cores), fall back to this host's own cost.
  const summed = hosts.filter((item) => (item.state === "ok" || item.state === "unpriced") && item.cost !== undefined)
  const counted = summed.length ? summed : hosts.filter((item) => item.current && item.cost !== undefined)
  if (!counted.length) return undefined
  const observedAt = Math.min(...counted.map((item) => item.observedAt ?? now))
  const exact = hosts.every((item) => item.state === "ok" && now - (item.observedAt ?? 0) <= STALE_MS)
  return {
    total: counted.reduce((sum, item) => sum + (item.cost ?? 0), 0),
    estimate: true,
    partial: !exact,
    observedAt,
    hosts,
    counted: counted.map((item) => item.id),
  }
}

/** A model with tokens but no price: older Cores report it as cost 0, newer ones as missing-rate. */
export const unpriced = (model: { cost: number | null; coverage?: string; tokens: { input: number; output: number; cache: { read: number } } }) =>
  model.coverage ? model.coverage === "missing-rate" : !model.cost && model.tokens.input + model.tokens.output + model.tokens.cache.read > 0

/** Visual bands from the recorded UX contract; not budget alarms. */
export const costBand = (total: number) => total >= 500 ? "high" : total >= 150 ? "mid" : "low"

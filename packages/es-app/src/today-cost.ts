/* Today's estimated AI spend on this host, for the title-bar badge (COST-01, ux-feel contract in
 * DESK-AND-SIDEBARS.md). One rollup read when first shown; afterwards re-read only after a turn
 * finishes (session.idle on the existing activity stream) or the tab returns, at most once a minute.
 * No polling. */
import { createSignal } from "solid-js"
import { oc, type UsageDaily } from "./api"

const MIN_GAP_MS = 60_000

const [usage, setUsage] = createSignal<UsageDaily | undefined>()
// "unavailable": this host's Core has no usage route (or the read failed); the badge hides.
const [state, setState] = createSignal<"idle" | "ready" | "unavailable">("idle")
let lastRead = 0
let inflight: Promise<void> | undefined
let timer: ReturnType<typeof setTimeout> | undefined

const read = () => (inflight ??= (async () => {
  lastRead = Date.now()
  try {
    const value = await oc.usageDaily(1, AbortSignal.timeout(15_000))
    setUsage(value)
    setState(value ? "ready" : "unavailable")
  } catch {
    // Keep the last known total (it turns muted once stale); hide only if there never was one.
    if (!usage()) setState("unavailable")
  } finally {
    inflight = undefined
  }
})())

/** Starts the first read; later calls do nothing. */
export const startTodayCost = () => {
  if (state() !== "idle" || inflight) return
  void read()
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") touchTodayCost() })
}

/** Something may have added spend: re-read, coalesced to at most one read a minute. */
export const touchTodayCost = () => {
  if (state() === "idle" || timer) return
  const wait = Math.max(0, lastRead + MIN_GAP_MS - Date.now())
  timer = setTimeout(() => { timer = undefined; void read() }, wait)
}

export const todayCost = () => {
  const value = usage()
  const today = value?.days[0]
  if (state() !== "ready" || !value || !today) return undefined
  const used = today.models.filter((model) => model.coverage !== "no-usage")
  const priced = used.filter((model) => !unpriced(model))
  // Nothing priced is an unknown total, not $0: the badge hides.
  if (today.cost === null || (used.length && !priced.length)) return undefined
  return {
    total: today.cost,
    estimate: value.estimate,
    partial: !value.coverage.backfilled || today.complete === false || priced.length < used.length,
    observedAt: Date.parse(value.observedAt),
    scope: value.coverage.scope,
    liveSince: value.coverage.liveSince,
    models: used.length,
    priced: priced.length,
  }
}

/** A model with tokens but no price: older Cores report it as cost 0, newer ones as missing-rate. */
export const unpriced = (model: { cost: number | null; coverage?: string; tokens: { input: number; output: number; cache: { read: number } } }) =>
  model.coverage ? model.coverage === "missing-rate" : !model.cost && model.tokens.input + model.tokens.output + model.tokens.cache.read > 0

/** Visual bands from the recorded UX contract; not budget alarms. */
export const costBand = (total: number) => total >= 500 ? "high" : total >= 150 ? "mid" : "low"

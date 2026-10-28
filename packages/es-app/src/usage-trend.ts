/* Pure aggregation for the Usage page: daily stacked trend, model totals and cost cuts from one
 * /experimental/usage/daily read. Unknown days stay unknown (never $0) and unpriced usage never counts as free. */
import type { UsageDaily, UsageTokens } from "./api"
import { unpriced } from "./today-cost"

type Day = UsageDaily["days"][number]
type Model = Day["models"][number]

/** How much of a day's spend the rollup can vouch for. */
export type DayState =
  /** Every turn on this day is counted and priced. */
  | "complete"
  /** Today, still accruing. */
  | "today"
  /** Counted, but some usage has no price, so the total is a lower bound. */
  | "partly-priced"
  /** Usage recorded but nothing priced: cost unknown. */
  | "unpriced"
  /** The rollup started counting partway through this day (or later): turns are missing. */
  | "incomplete"
  /** Fully covered and nothing ran. */
  | "idle"

export type TrendDay = {
  day: string
  state: DayState
  /** Priced estimate for the day, or null when unknown. A lower bound for "partly-priced"/"incomplete". */
  cost: number | null
  /** Priced cost per series key (see `series`). */
  parts: Record<string, number>
}

export type ModelTotal = {
  key: string
  provider: string
  model: string
  cost: number
  share: number
  tokens: UsageTokens
  /** Some of this model's usage had no price, so `cost` is a lower bound (often zero). */
  unpriced: boolean
  /** Inference ran on a local server: no spend. */
  local: boolean
}

export type Cut = { id: string; title: string; detail: string }

export type Trend = {
  days: TrendDay[]
  /** Stack order, most expensive first; at most `MAX_SERIES` models plus "other". */
  series: string[]
  models: ModelTotal[]
  /** Sum of priced estimates over the window (lower bound when any day is not "complete"/"idle"/"today"). */
  total: number
  /** True when every day in the window is fully counted and priced. */
  exact: boolean
  /** Days in the window whose state leaves the total incomplete. */
  gaps: number
  tokens: UsageTokens
  cuts: Cut[]
}

export const MAX_SERIES = 5
export const OTHER = "other"

export function buildTrend(usage: UsageDaily, window: number, today: string): Trend {
  const days = usage.days.slice(0, window).toReversed()
  const models = modelTotals(days)
  const series = [...models.filter((model) => model.cost > 0).slice(0, MAX_SERIES).map((model) => model.key)]
  if (models.filter((model) => model.cost > 0).length > MAX_SERIES) series.push(OTHER)
  const trend = days.map((day) => trendDay(day, usage, today, series))
  const total = trend.reduce((sum, day) => sum + (day.cost ?? 0), 0)
  const tokens = models.reduce((sum, model) => addTokens(sum, model.tokens), zeroTokens())
  const gaps = trend.filter((day) => day.state === "incomplete" || day.state === "unpriced" || day.state === "partly-priced").length
  return { days: trend, series, models, total, exact: gaps === 0, gaps, tokens, cuts: cuts(trend, models, tokens, total) }
}

export const modelKey = (model: { provider: string; model: string }) => `${model.provider}/${model.model}`

function modelTotals(days: Day[]): ModelTotal[] {
  const totals = new Map<string, ModelTotal>()
  for (const model of days.flatMap((day) => day.models)) {
    if (model.coverage === "no-usage") continue
    const key = modelKey(model)
    const total = totals.get(key) ?? { key, provider: model.provider, model: model.model, cost: 0, share: 0, tokens: zeroTokens(), unpriced: false, local: false }
    total.cost += model.cost ?? 0
    total.tokens = addTokens(total.tokens, model.tokens)
    total.unpriced ||= unpricedModel(model)
    total.local ||= model.coverage === "local"
    totals.set(key, total)
  }
  const all = [...totals.values()]
  const sum = all.reduce((acc, model) => acc + model.cost, 0)
  return all.map((model) => ({ ...model, share: sum > 0 ? model.cost / sum : 0 })).toSorted((a, b) => b.cost - a.cost || tokenCount(b.tokens) - tokenCount(a.tokens))
}

function trendDay(day: Day, usage: UsageDaily, today: string, series: string[]): TrendDay {
  const used = day.models.filter((model) => model.coverage !== "no-usage")
  const parts: Record<string, number> = {}
  for (const model of used) {
    if (!model.cost) continue
    const key = series.includes(modelKey(model)) ? modelKey(model) : OTHER
    parts[key] = (parts[key] ?? 0) + model.cost
  }
  return { day: day.day, state: dayState(day, used, usage, today), cost: day.cost ?? null, parts }
}

function dayState(day: Day, used: Model[], usage: UsageDaily, today: string): DayState {
  if (day.complete === false || beforeCoverage(day.day, usage)) return "incomplete"
  if (used.length && day.cost == null) return "unpriced"
  if (used.some(unpricedModel)) return "partly-priced"
  if (day.day === today) return "today"
  return used.length ? "complete" : "idle"
}

/** Older Cores lack `complete`: a day that ends before counting began is missing turns. */
function beforeCoverage(day: string, usage: UsageDaily) {
  if (usage.coverage.backfilled || !usage.coverage.liveSince) return false
  const since = new Date(usage.coverage.liveSince)
  return day <= localDay(since, usage.offsetMinutes)
}

const localDay = (at: Date, offsetMinutes: number) => new Date(at.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10)

/** A zero price with tokens means the price is unknown (often a gateway), not free. Local servers cost nothing. */
export const unpricedModel = (model: Model) => model.coverage !== "local" && model.coverage !== "no-usage" && unpriced(model)

function cuts(days: TrendDay[], models: ModelTotal[], tokens: UsageTokens, total: number): Cut[] {
  if (total <= 0) return []
  const out: Cut[] = []
  const top = models[0]
  if (top && top.share >= 0.5)
    out.push({
      id: "top-model",
      title: `${pct(top.share)} of the estimate is ${top.model}`,
      detail: "Route defined implementation, review and verify work to a cheaper default; keep the strong model for ambiguous design and escalation.",
    })
  const prompt = tokens.input + tokens.cache.read + tokens.cache.write
  if (prompt > 0 && tokens.cache.write / prompt >= 0.02)
    out.push({
      id: "cache-write",
      title: `${pct(tokens.cache.write / prompt)} of prompt tokens were cache writes`,
      detail: "A cache write is priced many times higher than a cache read, so a small share of writes can be most of the prompt bill. Writes spike when an agent resumes after its cache expired or its context was rebuilt: batch passive mail and hand off before contexts grow huge.",
    })
  const priced = days.filter((day) => day.cost != null && day.cost > 0).map((day) => day.cost!)
  const median = priced.toSorted((a, b) => a - b)[Math.floor(priced.length / 2)] ?? 0
  const peak = days.reduce<TrendDay | undefined>((best, day) => ((day.cost ?? 0) > (best?.cost ?? 0) ? day : best), undefined)
  if (peak?.cost && priced.length >= 3 && median > 0 && peak.cost >= 2 * median)
    out.push({
      id: "peak-day",
      title: `${peak.day} cost ${(peak.cost / median).toFixed(1)}× a typical day`,
      detail: "Check which agents ran long that day: peaks usually mean many concurrent long-context sessions rather than more output.",
    })
  return out
}

const pct = (value: number) => `${Math.round(value * 100)}%`
const tokenCount = (tokens: UsageTokens) => tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
const zeroTokens = (): UsageTokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
const addTokens = (a: UsageTokens, b: UsageTokens): UsageTokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
})

export type SessionUsage = { sessionID: string; parentID?: string; directory?: string; cost: number | null; pricedCost: number; unpricedTokens: number }
export type DirectoryGroup = {
  key: string
  /** Lane name when the directory sits in an editspace lane, else the directory's last two segments. */
  label: string
  /** "lane" only from the editspace path layout (…/lanes/<lane>/…); never a guessed project or workstream. */
  kind: "lane" | "directory" | "unknown"
  pricedCost: number
  unpriced: boolean
  sessions: number
}

/** Groups ranked sessions by where they ran. `partial` when the route hit its limit, so smaller groups may be missing. */
export function groupByDirectory(sessions: SessionUsage[], limit: number): { groups: DirectoryGroup[]; partial: boolean } {
  const groups = new Map<string, DirectoryGroup>()
  for (const session of sessions) {
    const place = locate(session.directory)
    const group = groups.get(place.key) ?? { ...place, pricedCost: 0, unpriced: false, sessions: 0 }
    group.pricedCost += session.pricedCost
    group.unpriced ||= session.cost == null || session.unpricedTokens > 0
    group.sessions += 1
    groups.set(place.key, group)
  }
  return { groups: [...groups.values()].toSorted((a, b) => b.pricedCost - a.pricedCost), partial: sessions.length >= limit }
}

function locate(directory?: string): Pick<DirectoryGroup, "key" | "label" | "kind"> {
  if (!directory) return { key: "", label: "unknown directory", kind: "unknown" }
  const lane = directory.match(/^(.*?\/lanes\/([^/]+))(?:\/|$)/)
  if (lane && /(?:^|\/)(?:\.editspace|editspaces\/[^/]+)\/lanes\//.test(lane[1] + "/")) return { key: lane[1], label: lane[2], kind: "lane" }
  const parts = directory.split("/").filter(Boolean)
  return { key: directory, label: parts.slice(-2).join("/") || directory, kind: "directory" }
}

/* Stacked daily spend by model. HTML flex columns (not SVG) so the time axis follows the page
 * direction in RTL and each day is a real button: arrow keys move between days, Enter/click selects. */
import { For, Show } from "solid-js"
import { OTHER, type DayState, type Trend, type TrendDay } from "../usage-trend"

export const SERIES_COLORS = ["var(--peach)", "var(--blue)", "var(--green)", "var(--mauve)", "var(--yellow)"]
export const seriesColor = (series: string[], key: string) =>
  key === OTHER ? "var(--overlay0)" : SERIES_COLORS[series.indexOf(key) % SERIES_COLORS.length]

export const STATE_LABEL: Record<DayState, string> = {
  complete: "",
  today: "today, still counting",
  "partly-priced": "some usage unpriced",
  unpriced: "not priced",
  incomplete: "not fully counted",
  idle: "no usage",
}

export function UsageChart(props: {
  trend: Trend
  selected?: string
  onSelect: (day: string) => void
  money: (value: number) => string
  label: (day: string) => string
  tick: (day: string, window: number) => string
}) {
  const max = () => Math.max(...props.trend.days.map((day) => day.cost ?? 0), 0)
  const unknown = (day: TrendDay) => day.state === "unpriced" || (day.state === "incomplete" && !day.cost)
  const describe = (day: TrendDay) => {
    const cost = day.cost == null ? "cost unknown" : props.money(day.cost)
    const state = STATE_LABEL[day.state]
    const parts = props.trend.series.filter((key) => day.parts[key]).map((key) => `${short(key)} ${props.money(day.parts[key])}`)
    return [props.label(day.day), cost, state, ...parts].filter(Boolean).join(", ")
  }
  const keys = (event: KeyboardEvent, index: number) => {
    const rtl = getComputedStyle(event.currentTarget as Element).direction === "rtl"
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, Home: -Infinity, End: Infinity }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const days = props.trend.days
    const next = Math.max(0, Math.min(days.length - 1, Number.isFinite(step) ? index + step : step > 0 ? days.length - 1 : 0))
    props.onSelect(days[next].day)
    const bars = (event.currentTarget as HTMLElement).parentElement?.children
    ;(bars?.[next] as HTMLElement | undefined)?.focus()
  }
  const days = () => props.trend.days
  // Label every day in a week view; in longer views, every seventh day counted back from today.
  const tick = (index: number) => days().length <= 7 || (days().length - 1 - index) % 7 === 0
  return <div class="usage-chart-wrap">
  <div class="usage-chart" role="group" aria-label="Estimated spend per day, stacked by model">
    <For each={props.trend.days}>{(day, index) => <button
      type="button"
      class="usage-bar"
      classList={{ selected: props.selected === day.day, gap: day.state !== "complete" && day.state !== "idle" && day.state !== "today" }}
      data-state={day.state}
      data-day={day.day}
      aria-pressed={props.selected === day.day}
      aria-label={describe(day)}
      title={describe(day)}
      tabindex={(props.selected ?? props.trend.days.at(-1)?.day) === day.day ? 0 : -1}
      onClick={() => props.onSelect(day.day)}
      onKeyDown={(event) => keys(event, index())}
    >
      <span class="usage-bar-stack" style={{ height: max() > 0 ? `${((day.cost ?? 0) / max()) * 100}%` : "0%" }}>
        <For each={props.trend.series.filter((key) => day.parts[key])}>{(key) => <span
          class="usage-bar-part"
          style={{ "flex-grow": day.parts[key], background: seriesColor(props.trend.series, key) }}
        />}</For>
      </span>
      <Show when={unknown(day)}><span class="usage-bar-unknown" aria-hidden="true">?</span></Show>
    </button>}</For>
  </div>
  <div class="usage-axis" aria-hidden="true">
    <For each={days()}>{(day, index) => <span>{tick(index()) ? props.tick(day.day, days().length) : ""}</span>}</For>
  </div>
  </div>
}

export const short = (key: string) => key === OTHER ? "other" : key.slice(key.indexOf("/") + 1)

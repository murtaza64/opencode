/* Estimated spend on this host, per local day and model, from Core's usage rollup (COST-01 U1, Usage v2).
 * One 30-day read on open serves Today, the 7/30-day trend and the model table; re-read only when the tab
 * returns after a minute away, or on Refresh. No polling.
 * Each host is its own origin, so this page covers this host only and says so: never a global total. */
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { oc, type UsageDaily, type UsageLimit, type UsageSessions, type UsageTokens } from "../api"
import { seriesColor, short, STATE_LABEL, UsageChart } from "../components/usage-chart"
import { buildTrend, OTHER, unpricedModel, type Trend } from "../usage-trend"
import { AppHeader } from "../components/native-header"
import { host, readHost } from "../host"
import { unpriced } from "../today-cost"
import "./home.css"
import "./usage.css"

const DAYS = 30
const WINDOWS = [7, 30] as const
const REVIEW = "Cost review: cost-report/index.html in lane sheep-review"
const STALE_MS = 60_000

export default function UsagePage() {
  onMount(() => void readHost())
  const [version, setVersion] = createSignal(0)
  const [usage, { refetch }] = createResource(version, () => oc.usageDaily(DAYS))
  onMount(() => {
    // Returning to the tab re-reads a stale rollup once; a hidden tab reads nothing.
    const visible = () => {
      const at = usage()?.observedAt ? Date.parse(usage()!.observedAt) : 0
      if (document.visibilityState === "visible" && !usage.loading && Date.now() - at > STALE_MS) setVersion((value) => value + 1)
    }
    document.addEventListener("visibilitychange", visible)
    onCleanup(() => document.removeEventListener("visibilitychange", visible))
  })
  const label = () => host()?.label ?? "This host"
  return <main class="attention-home usage-page">
    <AppHeader><h1>Usage</h1><span class="home-muted">{label()}</span></AppHeader>
    <Show when={!usage.error} fallback={<div class="home-warning" role="alert">Usage unavailable: {String(usage.error?.message ?? usage.error)} <button onClick={() => refetch()}>Retry</button></div>}>
      <Show when={usage.state !== "unresolved" && !(usage.loading && !usage.latest)} fallback={<p class="home-muted">Loading usage…</p>}>
        <Show when={usage.latest} fallback={<p class="home-muted">Usage is not available on {label()} yet: its Core predates the usage rollup.</p>}>
          {(value) => <Report usage={value()} host={label()} refresh={() => refetch()} loading={usage.loading} />}
        </Show>
      </Show>
    </Show>
  </main>
}

const Report = (props: { usage: UsageDaily; host: string; refresh: () => void; loading: boolean }) => {
  const today = () => props.usage.days[0]
  const unpriced = () => today()?.models.some(missingPrice) ?? false
  return <>
    <section class="usage-today" aria-label="Today">
      <div class="usage-eyebrow">TODAY · {props.host.toUpperCase()} ONLY · ESTIMATE</div>
      <div class="usage-total"><span data-usage-total>{today()?.cost == null ? "Not priced" : money(today()!.cost!)}</span><Show when={unpriced()}><span class="usage-unpriced"> + unpriced usage</span></Show></div>
      <p class="home-muted">
        As of {clock(props.usage.observedAt)}
        <Show when={!props.usage.coverage.backfilled}> · <span class="usage-incomplete" data-usage-incomplete>Incomplete: counted since {props.usage.coverage.liveSince ? clock(props.usage.coverage.liveSince) : "this Core started"}; earlier turns today are missing</span></Show>
        {" · "}<button class="usage-refresh" disabled={props.loading} onClick={() => props.refresh()}>{props.loading ? "Refreshing…" : "Refresh"}</button>
      </p>
      <p class="home-source">{props.usage.coverage.scope}. Other hosts are not included.</p>
    </section>
    <section aria-label="By model">
      <h3>By model, today</h3>
      <Show when={today()?.models.length} fallback={<p class="home-muted">No model usage recorded today.</p>}>
        <table class="usage-table" data-usage-today-table>
          <thead><tr><th scope="col">Model</th><th scope="col">Tokens in / out</th><th scope="col">Estimate</th></tr></thead>
          <tbody>
            <For each={today()!.models.filter((model) => model.coverage !== "no-usage").toSorted((a, b) => (b.cost ?? 0) - (a.cost ?? 0))}>{(model) => <tr>
              <td><bdi dir="ltr">{model.provider}/{model.model}</bdi></td>
              <td>{count(inputTokens(model.tokens))} / {count(model.tokens.output + model.tokens.reasoning)}</td>
              {/* A zero price with tokens means the price is unknown (often a gateway), not free. */}
              <td>{missingPrice(model) ? <span class="usage-unpriced" title="No price for this model; its cost is not counted">pricing missing</span> : money(model.cost ?? 0)}</td>
            </tr>}</For>
          </tbody>
        </table>
      </Show>
    </section>
    <TrendSection usage={props.usage} />
    <Show when={props.usage.rateLimits.providers.length}>
      <section aria-label="Rate limits">
        <h3>Provider rate limits</h3>
        <p class="home-muted">From each provider's latest response headers. Not a plan or subscription quota.</p>
        <ul class="usage-limits">
          <For each={props.usage.rateLimits.providers}>{(item) => <li>
            <bdi dir="ltr">{item.provider}</bdi>
            <span>{[limit("requests", item.requests), limit("tokens", item.tokens), limit("input tokens", item.inputTokens), limit("output tokens", item.outputTokens)].filter(Boolean).join(" · ") || "no limits reported"}</span>
            <span class="home-muted">seen {clock(item.observedAt)}</span>
          </li>}</For>
        </ul>
      </section>
    </Show>
    <p class="home-source">{props.usage.basis}</p>
  </>
}

const missingPrice = unpriced
const inputTokens = (tokens: UsageTokens) => tokens.input + tokens.cache.read + tokens.cache.write
const money = (value: number) => value > 0 && value < 0.01 ? "<$0.01" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value)
const count = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)
const clock = (iso: string) => { const at = Date.parse(iso); return Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "unknown time" }
const tick = (day: string, window: number) => new Date(`${day}T12:00:00`).toLocaleDateString([], window <= 7 ? { weekday: "short" } : { month: "short", day: "numeric" })
const weekday = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
const limit = (name: string, value?: UsageLimit) => value?.remaining !== undefined
  ? `${value.remaining.toLocaleString()}${value.limit !== undefined ? ` of ${value.limit.toLocaleString()}` : ""} ${name} left${value.reset ? ` (resets ${value.reset})` : ""}` : undefined

const TrendSection = (props: { usage: UsageDaily }) => {
  const [window, setWindow] = createSignal<(typeof WINDOWS)[number]>(7)
  const [selected, setSelected] = createSignal<string>()
  const [table, setTable] = createSignal(false)
  const today = () => props.usage.days[0]?.day ?? ""
  const trend = createMemo(() => buildTrend(props.usage, window(), today()))
  const day = () => trend().days.find((item) => item.day === selected()) ?? trend().days.at(-1)
  const dayModels = () => props.usage.days.find((item) => item.day === day()?.day)?.models.filter((model) => model.coverage !== "no-usage").toSorted((a, b) => (b.cost ?? 0) - (a.cost ?? 0)) ?? []
  const [sessions] = createResource(window, (days) => oc.usageSessions(days).catch(() => undefined))
  return <>
    <section aria-label="Trend" class="usage-trend">
      <div class="usage-trend-head">
        <h3>Last {window()} days</h3>
        <div class="usage-window" role="radiogroup" aria-label="Window">
          <For each={WINDOWS}>{(value) => <button type="button" role="radio" aria-checked={window() === value} classList={{ selected: window() === value }} onClick={() => { setWindow(value); setSelected(undefined) }}><bdi dir="ltr">{value} days</bdi></button>}</For>
        </div>
      </div>
      <Show when={props.usage.days.length >= window()} fallback={<p class="home-muted">This Core returned {props.usage.days.length} days.</p>}>
        <p class="usage-window-total"><span data-usage-window-total>{money(trend().total)}</span>
          <span class="home-muted">{trend().exact ? " estimated" : ` or more: ${trend().gaps} ${trend().gaps === 1 ? "day is" : "days are"} not fully counted or priced`}</span></p>
        <UsageChart trend={trend()} selected={day()?.day} onSelect={setSelected} money={money} label={weekday} tick={tick} />
        <ul class="usage-legend" aria-label="Models">
          <For each={trend().series}>{(key) => <li><i style={{ background: seriesColor(trend().series, key) }} /><bdi dir="ltr">{short(key)}</bdi></li>}</For>
          <li class="home-muted">? = cost unknown · faded = not fully counted</li>
        </ul>
        <Show when={day()}>{(value) => <div class="usage-day-detail" aria-live="polite">
          <b>{weekday(value().day)}</b>{" "}
          <span>{value().cost == null ? "cost unknown" : money(value().cost!)}</span>
          <Show when={STATE_LABEL[value().state]}><span class="usage-incomplete"> · {STATE_LABEL[value().state]}</span></Show>
          <span class="home-muted"> · {dayModels().map((model) => `${model.model} ${unpricedModel(model) ? "unpriced" : money(model.cost ?? 0)}`).join(" · ") || "no model usage"}</span>
        </div>}</Show>
        <button type="button" class="usage-link" aria-expanded={table()} onClick={() => setTable(!table())}>{table() ? "Hide table" : "Show as table"}</button>
        <Show when={table()}>
          <table class="usage-table" data-usage-day-table>
            <thead><tr><th scope="col">Day</th><th scope="col">Estimate</th><th scope="col">Coverage</th></tr></thead>
            <tbody><For each={trend().days.toReversed()}>{(item) => <tr>
              <td>{weekday(item.day)}</td><td>{item.cost == null ? "unknown" : money(item.cost)}</td><td>{STATE_LABEL[item.state] || "counted"}</td>
            </tr>}</For></tbody>
          </table>
        </Show>
      </Show>
    </section>
    <ModelSection trend={trend()} window={window()} />
    <Show when={trend().cuts.length}>
      <section aria-label="Where to cut" class="usage-cuts">
        <h3>Where to cut</h3>
        <ul><For each={trend().cuts}>{(cut) => <li data-cut={cut.id}><b>{cut.title}</b><span class="home-muted">{cut.detail}</span></li>}</For></ul>
        <p class="home-source">From this page's numbers only. Background: {REVIEW}.</p>
      </section>
    </Show>
    <SessionSection sessions={sessions()} loading={sessions.loading} window={window()} />
  </>
}

const ModelSection = (props: { trend: Trend; window: number }) =>
  <section aria-label="By model">
    <h3>By model, {props.window} days</h3>
    <Show when={props.trend.models.length} fallback={<p class="home-muted">No model usage recorded in this window.</p>}>
      <div class="usage-scroll"><table class="usage-table" data-usage-model-table>
        <thead><tr><th scope="col">Model</th><th scope="col">Estimate</th><th scope="col">Share</th><th scope="col">Cache write</th><th scope="col">Cache read</th><th scope="col">Output</th></tr></thead>
        <tbody><For each={props.trend.models}>{(model) => <tr>
          <td><i class="usage-swatch" style={{ background: props.trend.series.includes(model.key) ? seriesColor(props.trend.series, model.key) : seriesColor(props.trend.series, OTHER) }} /><bdi dir="ltr">{model.key}</bdi></td>
          <td>{model.local ? "local" : model.unpriced && !model.cost ? <span class="usage-unpriced">pricing missing</span> : <>{money(model.cost)}<Show when={model.unpriced}><span class="usage-unpriced"> + unpriced</span></Show></>}</td>
          <td>{model.cost ? `${Math.round(model.share * 100)}%` : ""}</td>
          <td>{count(model.tokens.cache.write)}</td>
          <td>{count(model.tokens.cache.read)}</td>
          <td>{count(model.tokens.output + model.tokens.reasoning)}</td>
        </tr>}</For></tbody>
      </table></div>
      <p class="home-source">Cache writes cost far more per token than cache reads; output includes reasoning.</p>
    </Show>
  </section>

const SessionSection = (props: { sessions?: UsageSessions; loading: boolean; window: number }) =>
  <section aria-label="Top sessions">
    <h3>Most expensive sessions, {props.window} days</h3>
    <Show when={!props.loading} fallback={<p class="home-muted">Loading…</p>}>
      <Show when={props.sessions} fallback={<p class="home-muted" data-usage-sessions-unavailable>Per-session spend needs a newer Core on this host.</p>}>
        {(value) => <>
          <Show when={value().sessions.length} fallback={<p class="home-muted">No session usage in this window.</p>}>
            <ol class="usage-sessions">
              <For each={value().sessions}>{(item) => <li>
                <Show when={item.directory} fallback={<bdi>{item.title || item.sessionID}</bdi>}>
                  <a href={`/session/${encodeURIComponent(item.sessionID)}?directory=${encodeURIComponent(item.directory!)}`}><bdi>{item.title || item.sessionID}</bdi></a>
                </Show>
                <span class="home-muted"><bdi dir="ltr">{item.directory ? lane(item.directory) : "unknown directory"}</bdi>{item.parentID ? " · subagent" : ""}</span>
                <span>{item.cost == null && !item.pricedCost ? <span class="usage-unpriced">pricing missing</span> : money(item.cost ?? item.pricedCost)}{item.cost == null && item.pricedCost ? <span class="usage-unpriced"> + unpriced</span> : ""}</span>
              </li>}</For>
            </ol>
          </Show>
          <Show when={!value().coverage.backfilled}><p class="home-muted">Counted since {value().coverage.since ? weekday(value().coverage.since!.slice(0, 10)) : "this Core started"}; earlier sessions may be missing.</p></Show>
        </>}
      </Show>
    </Show>
  </section>

const lane = (directory: string) => directory.match(/\/lanes\/([^/]+)/)?.[1] ?? directory.split("/").filter(Boolean).at(-1) ?? directory


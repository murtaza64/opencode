/* Estimated spend on this host, per local day and model, from Core's usage rollup (COST-01 U1).
 * One read on open; re-read only when the tab returns after a minute away, or on Refresh. No polling.
 * Each host is its own origin, so this page covers this host only and says so: never a global total. */
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { oc, type UsageDaily, type UsageLimit, type UsageTokens } from "../api"
import { AppHeader } from "../components/native-header"
import { host, readHost } from "../host"
import { unpriced } from "../today-cost"
import "./home.css"
import "./usage.css"

const DAYS = 7
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
        <table class="usage-table">
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
    <section aria-label="Last 7 days">
      <h3>Last {props.usage.days.length} days</h3>
      <ol class="usage-days">
        <For each={props.usage.days}>{(day, index) => <li>
          <span>{index() === 0 ? "Today" : weekday(day.day)}</span>
          <span>{day.cost == null ? (day.models.length ? "not priced" : "none") : money(day.cost)}{day.cost != null && day.models.some(missingPrice) ? " + unpriced" : ""}{day.complete === false ? " · incomplete" : ""}</span>
        </li>}</For>
      </ol>
      <Show when={!props.usage.coverage.backfilled}><p class="home-muted">Days before {props.usage.coverage.liveSince ? clock(props.usage.coverage.liveSince) : "this Core started"} may be missing.</p></Show>
    </section>
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
const weekday = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
const limit = (name: string, value?: UsageLimit) => value?.remaining !== undefined
  ? `${value.remaining.toLocaleString()}${value.limit !== undefined ? ` of ${value.limit.toLocaleString()}` : ""} ${name} left${value.reset ? ` (resets ${value.reset})` : ""}` : undefined

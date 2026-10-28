import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { costBand, startTodayCost, STALE_MS, todayCost, type HostCost } from "../today-cost"
import "./today-cost.css"

/** Title-bar "Today ~$142": combined origin-only cost, then any host that cannot be combined on its own
 * ("Mini ~$547") with a "partial" mark; colour-banded; hidden (never $0) when unknown. */
export const TodayCost = () => {
  onMount(startTodayCost)
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(tick))
  return <Show when={todayCost(now())}>{(cost) => {
    const approximate = () => cost().estimate || cost().partial
    const usd = (value: number) => `${approximate() ? "~" : ""}$${Math.round(value).toLocaleString()}`
    const stale = () => now() - cost().observedAt > STALE_MS
    const age = () => { const minutes = Math.max(0, Math.round((now() - cost().observedAt) / 60_000)); return minutes < 1 ? "just now" : `${minutes}m ago` }
    const clock = () => new Date(cost().observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    const hostLine = (item: HostCost) => `${item.label}: ${item.cost !== undefined ? `$${item.cost.toFixed(2)}` : item.state === "pending" ? "reading…" : item.state}${item.note ? ` (${item.note})` : ""}${item.observedAt ? ` · ${new Date(item.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}${cost().counted.includes(item.id) ? "" : item.cost !== undefined ? " · not in total" : ""}`
    const unsupported = () => cost().unsupported.length ? `partial: ${cost().unsupported.join(", ")} unsupported` : ""
    const title = () => [
      "Estimated spend today (local date), API-billed work agents",
      ...cost().hosts.map(hostLine),
      unsupported(),
      stale() ? `last updated ${clock()}` : `updated ${age()}`,
    ].filter(Boolean).join("\n")
    const spoken = () => [
      cost().total !== undefined ? `${approximate() ? "about " : ""}${Math.round(cost().total!)} dollars${cost().hosts.length > 1 ? " combined" : ""}` : "",
      ...cost().separate.map((item) => `${item.label} ${Math.round(item.cost ?? 0)} dollars`),
    ].filter(Boolean).join(", ")
    // Colour follows the largest figure shown: the combined total, or a lone host when nothing combines.
    const band = () => costBand(Math.max(cost().total ?? 0, ...cost().separate.map((item) => item.cost ?? 0)))
    return <span class="today-cost" data-band={band()} data-stale={stale() ? "true" : undefined} data-partial={String(cost().partial)} title={title()}
      role="status" aria-label={`AI spend today: ${spoken()}${approximate() ? ", estimate" : ""}${unsupported() ? `; ${unsupported()}` : ""}`}>
      <span class="today-cost-label" aria-hidden="true">Today</span>
      <Show when={cost().total !== undefined}>
        <span class="today-cost-amount" aria-hidden="true"><Show when={approximate()}><span class="today-cost-approx">~</span></Show>${Math.round(cost().total!).toLocaleString()}</span>
      </Show>
      <For each={cost().separate}>{(item) =>
        <span class="today-cost-host" data-host={item.id} aria-hidden="true"><bdi>{item.label}</bdi> {usd(item.cost ?? 0)}</span>}
      </For>
      <Show when={unsupported()}><span class="today-cost-partial" aria-hidden="true">partial</span></Show>
    </span>
  }}</Show>
}

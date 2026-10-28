import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { costBand, startTodayCost, STALE_MS, todayCost, type HostCost } from "../today-cost"
import "./today-cost.css"

/** Title-bar "Today ~$142": always visible, colour-banded, hidden (never $0) when unknown. */
export const TodayCost = () => {
  onMount(startTodayCost)
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(tick))
  return <Show when={todayCost(now())}>{(cost) => {
    const approximate = () => cost().estimate || cost().partial
    const dollars = () => Math.round(cost().total)
    const stale = () => now() - cost().observedAt > STALE_MS
    const age = () => { const minutes = Math.max(0, Math.round((now() - cost().observedAt) / 60_000)); return minutes < 1 ? "just now" : `${minutes}m ago` }
    const clock = () => new Date(cost().observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    const hostLine = (item: HostCost) => `${item.label}: ${item.cost !== undefined ? `$${item.cost.toFixed(2)}` : item.state === "pending" ? "reading…" : item.state}${item.note ? ` (${item.note})` : ""}${item.observedAt ? ` · ${new Date(item.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}${cost().counted.includes(item.id) ? "" : item.cost !== undefined ? " · not in total" : ""}`
    const title = () => [
      "Estimated spend today (local date), API-billed work agents",
      ...cost().hosts.map(hostLine),
      stale() ? `last updated ${clock()}` : `updated ${age()}`,
    ].filter(Boolean).join("\n")
    return <span class="today-cost" data-band={costBand(cost().total)} data-stale={stale() ? "true" : undefined} data-partial={String(cost().partial)} title={title()}
      role="status" aria-label={`AI spend today: ${approximate() ? "about " : ""}${dollars()} dollars${approximate() ? ", estimate" : ""}`}>
      <span class="today-cost-label" aria-hidden="true">Today</span>
      <span class="today-cost-amount" aria-hidden="true"><Show when={approximate()}><span class="today-cost-approx">~</span></Show>${dollars().toLocaleString()}</span>
    </span>
  }}</Show>
}

import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { costBand, startTodayCost, todayCost } from "../today-cost"
import "./today-cost.css"

const STALE_MS = 15 * 60_000

/** Title-bar "Today ~$142": always visible, colour-banded, hidden (never $0) when unknown. */
export const TodayCost = () => {
  onMount(startTodayCost)
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(tick))
  return <Show when={todayCost()}>{(cost) => {
    const approximate = () => cost().estimate || cost().partial
    const dollars = () => Math.round(cost().total)
    const stale = () => now() - cost().observedAt > STALE_MS
    const age = () => { const minutes = Math.max(0, Math.round((now() - cost().observedAt) / 60_000)); return minutes < 1 ? "just now" : `${minutes}m ago` }
    const clock = () => new Date(cost().observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    const title = () => [
      `Estimated spend today (local date), ${cost().scope}`,
      `${cost().priced} of ${cost().models} models priced`,
      cost().partial && cost().liveSince ? `counted since ${new Date(cost().liveSince!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "",
      stale() ? `last updated ${clock()}` : `updated ${age()}`,
    ].filter(Boolean).join(" · ")
    return <span class="today-cost" data-band={costBand(cost().total)} data-stale={stale() ? "true" : undefined} title={title()}
      role="status" aria-label={`AI spend today: ${approximate() ? "about " : ""}${dollars()} dollars${approximate() ? ", estimate" : ""}`}>
      <span class="today-cost-label" aria-hidden="true">Today</span>
      <span class="today-cost-amount" aria-hidden="true"><Show when={approximate()}><span class="today-cost-approx">~</span></Show>${dollars().toLocaleString()}</span>
    </span>
  }}</Show>
}

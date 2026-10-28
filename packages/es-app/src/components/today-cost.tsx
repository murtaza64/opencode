import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { costBand, startTodayCost, STALE_MS, todayCost, type HostCost } from "../today-cost"
import "./today-cost.css"

let nextID = 0

/** Title-bar "Work Today ~$142": one colour-banded summary of the Work hosts. When the hosts' costs cannot be
 * combined without double counting it reads "Work Today partial" with no amount. Per-host figures and
 * coverage open in its details. Hidden (never $0) when no host has a cost. */
export const TodayCost = () => {
  onMount(startTodayCost)
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(tick))
  const id = `today-cost-details-${++nextID}`
  return <Show when={todayCost(now())}>{(cost) => {
    const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    const stale = () => now() - cost().observedAt > STALE_MS
    const age = () => { const minutes = Math.max(0, Math.round((now() - cost().observedAt) / 60_000)); return minutes < 1 ? "just now" : `${minutes}m ago` }
    const hostLine = (item: HostCost) => `${item.label}: ${item.cost !== undefined ? `$${item.cost.toFixed(2)}` : item.state === "pending" ? "reading…" : item.state}${item.note ? ` (${item.note})` : ""}${item.observedAt ? ` · ${time(item.observedAt)}` : ""}${cost().counted.includes(item.id) || item.cost === undefined ? "" : " · not in total"}`
    const coverage = () => cost().total === undefined
      ? `partial: no combined total (${cost().gaps.map((item) => `${item.label} ${item.state}`).join(", ")})`
      : ""
    const updated = () => stale() ? `last updated ${time(cost().observedAt)}` : `updated ${age()}`
    const lines = () => [...cost().hosts.map(hostLine), coverage(), updated()].filter(Boolean)
    const title = () => ["Estimated Work spend today (local date), API-billed work agents", ...lines()].join("\n")
    const spoken = () => cost().total === undefined
      ? `partial, no combined total; ${cost().gaps.map((item) => `${item.label} ${item.state}`).join(", ")}`
      : `about ${Math.round(cost().total!)} dollars${cost().hosts.length > 1 ? " combined" : ""}, estimate`
    return <span class="today-cost" data-band={cost().total === undefined ? "partial" : costBand(cost().total!)}
      data-stale={stale() ? "true" : undefined} data-partial={String(cost().partial)} title={title()}
      role="status" aria-label={`AI spend today: ${spoken()}`}>
      <button type="button" class="today-cost-chip" popovertarget={id} style={{ "anchor-name": `--${id}` }} aria-label="Work Today details">
        <span class="today-cost-label" aria-hidden="true">Work Today</span>
        <Show when={cost().total !== undefined} fallback={<span class="today-cost-amount today-cost-unknown" aria-hidden="true">partial</span>}>
          <span class="today-cost-amount" aria-hidden="true"><span class="today-cost-approx">~</span>${Math.round(cost().total!).toLocaleString()}</span>
        </Show>
      </button>
      <div id={id} class="today-cost-details" popover="auto" style={{ "position-anchor": `--${id}` }}>
        <div class="today-cost-details-head">Estimated Work spend today</div>
        <For each={cost().hosts}>{(item) =>
          <div class="today-cost-host" data-host={item.id} data-state={item.state}>
            <bdi>{item.label}</bdi>
            <span>{item.cost !== undefined ? `$${item.cost.toFixed(2)}` : item.state === "pending" ? "reading…" : "—"}</span>
            <span class="today-cost-host-state">{item.state}{item.note ? ` · ${item.note}` : ""}{cost().counted.includes(item.id) || item.cost === undefined ? "" : " · not in total"}</span>
          </div>}
        </For>
        <Show when={coverage()}><div class="today-cost-coverage">{coverage()}</div></Show>
        <div class="today-cost-updated">{updated()}</div>
      </div>
    </span>
  }}</Show>
}

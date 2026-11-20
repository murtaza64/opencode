import { A } from "@solidjs/router"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { costBand, PERIODS, spendTotals, startTodayCost } from "../today-cost"
import "./today-cost.css"

/** Today · WTD · MTD across every WORK host. A partial amount is what is known so far (shown as "≥"); the
 * tooltip names what is missing. A period with nothing known shows no amount, never $0. */
export const TodayCost = () => {
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    startTodayCost()
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    onCleanup(() => clearInterval(timer))
  })
  const totals = () => spendTotals(now())
  const money = (value: number) => value < 0.01 && value > 0 ? "<$0.01" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const text = (id: (typeof PERIODS)[number]["id"]) => {
    const period = totals().periods[id]
    return period.amount === undefined ? "not reported" : `${period.partial ? "≥" : ""}${money(period.amount)}`
  }
  const gaps = () => [...new Set(PERIODS.flatMap(item => totals().periods[item.id].gaps))]
  const title = () => [
    "Spend across Work hosts (UTC; week starts Monday): OpenRouter billing plus estimated gateway and other providers.",
    ...PERIODS.map(item => `${item.label}: ${text(item.id)}`),
    ...(gaps().length ? ["Partial:", ...gaps().map(gap => `· ${gap}`)] : []),
  ].join("\n")
  return <Show when={PERIODS.some(item => totals().periods[item.id].amount !== undefined)}>
    <A href="/usage" class="today-cost today-cost-group" title={title()} data-partial={gaps().length ? "" : undefined}
      aria-label={`Spend ${PERIODS.map(item => `${item.name} ${text(item.id)}`).join(", ")}${gaps().length ? ", partial" : ""}. Open Usage`}>
      <For each={PERIODS}>{item => {
        const period = () => totals().periods[item.id]
        return <span class="today-cost-period" data-band={item.id === "today" && period().amount !== undefined ? costBand(period().amount!) : undefined}>
          <span class="today-cost-label">{item.label}</span>
          <bdi class="today-cost-amount" dir="ltr">{period().amount === undefined ? "—" : text(item.id)}</bdi>
        </span>
      }}</For>
    </A>
  </Show>
}

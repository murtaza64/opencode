import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js"
import { ApiStatusError, es, type CurrentWork } from "./api"

type Snapshot = { value: CurrentWork | null; checked: number; error: boolean; loading: boolean }
type Entry = {
  state: () => Snapshot
  set: (value: Snapshot) => void
  attempted: number
  summaryAttempted: number
  summaryWatermark: string | null
  wantSummary: boolean
  pending?: Promise<void>
  controller?: AbortController
}
const entries = new Map<string, Entry>()
let missingUntil = 0

const keyFor = (id: string, directory: string) => `${directory}\u0000${id}`
const entryFor = (id: string, directory: string) => {
  const key = keyFor(id, directory)
  const cached = entries.get(key)
  if (cached) return cached
  const [state, set] = createSignal<Snapshot>({ value: null, checked: 0, error: false, loading: false })
  const entry: Entry = { state, set, attempted: 0, summaryAttempted: 0, summaryWatermark: null, wantSummary: false }
  entries.set(key, entry)
  // Bound cache size, while preserving the selected session on subsequent reads.
  if (entries.size > 100) entries.delete(entries.keys().next().value!)
  return entry
}

export const currentWork = (id: string, directory: string, generate = false) => {
  const entry = entryFor(id, directory)
  const previous = entry.state()
  const interval = previous.error ? 30_000 : previous.value?.turn.status === "busy" || previous.value?.summary.status === "unavailable" ? 5_000 : 30_000
  const watermark = previous.value?.turn.watermark ?? null
  const ready = previous.value?.summary.status === "ready" && previous.value.summary.watermark === watermark &&
    Date.now() - (previous.value.summary.generated_at ?? 0) * 1000 < 300_000
  const requestSummary = generate && !ready && (entry.summaryWatermark !== watermark || Date.now() - entry.summaryAttempted >= 60_000)
  if (entry.pending) {
    if (requestSummary) entry.wantSummary = true
    return entry.state
  }
  if (Date.now() < missingUntil || (!requestSummary && Date.now() - entry.attempted < interval)) return entry.state
  entry.attempted = Date.now()
  if (requestSummary) {
    entry.summaryAttempted = Date.now()
    entry.summaryWatermark = watermark
  }
  const controller = new AbortController()
  entry.controller = controller
  entry.set({ ...previous, loading: !previous.value })
  entry.pending = es.currentWork(id, directory, requestSummary, controller.signal)
    .then((value) => {
      if (requestSummary && !watermark) entry.summaryWatermark = value.turn.watermark
      entry.set({ value, checked: Date.now(), error: false, loading: false })
    })
    .catch((error) => {
      if (controller.signal.aborted) return
      if (error instanceof ApiStatusError && error.routeMissing) missingUntil = Date.now() + 10 * 60_000
      entry.set({ ...entry.state(), error: true, loading: false })
    })
    .finally(() => {
      entry.pending = undefined
      entry.controller = undefined
      if (entry.wantSummary) {
        entry.wantSummary = false
        currentWork(id, directory, true)
      }
    })
  return entry.state
}

const elapsed = (seconds: number) => seconds < 60 ? `${seconds}s` : seconds < 3600
  ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`

export function CurrentWorkView(props: { id: string; directory: string; compact?: boolean }) {
  const [now, setNow] = createSignal(Date.now())
  const [snapshot, setSnapshot] = createSignal<Snapshot>({ value: null, checked: 0, error: false, loading: true })
  createEffect(() => {
    const id = props.id
    const directory = props.directory
    if (!id || !directory) return
    setSnapshot({ value: null, checked: 0, error: false, loading: true })
    const refresh = () => {
      const state = currentWork(id, directory)
      setSnapshot(state())
    }
    untrack(refresh)
    const timer = setInterval(() => { setNow(Date.now()); refresh() }, 5_000)
    const state = entryFor(id, directory).state
    // Solid tracks the shared signal; concurrent hover/panel reads use one request.
    createEffect(() => setSnapshot(state()))
    onCleanup(() => clearInterval(timer))
  })
  const value = () => snapshot().value
  const summary = () => value()?.summary
  const age = () => summary()?.generated_at != null ? elapsed(Math.max(0, Math.floor(now() / 1000) - summary()!.generated_at!)) : null
  return <section class={props.compact ? "current-work compact" : "current-work"} data-section="current-work">
    <div class={props.compact ? "ctx-subheading" : "info-heading"}>current turn</div>
    <Show when={value()} fallback={<div class="ctx-caption">{snapshot().loading ? "checking current turn…" : snapshot().error ? "current turn unavailable" : "current turn unknown"}</div>}>
      {(work) => <>
        <div class="current-work-line">{work().turn.status}{work().turn.elapsed_seconds != null ? ` · ${elapsed(work().turn.elapsed_seconds!)} elapsed` : " · elapsed unknown"}{snapshot().error ? " · refresh failed" : ""}</div>
        <Show when={work().turn.started_at != null}>
          <div class="current-work-line">started {new Date(work().turn.started_at!).toLocaleString()}</div>
        </Show>
        <div class="current-work-line mono">{work().turn.user_messages ?? "?"} user · {work().turn.assistant_messages ?? "?"} assistant · {work().turn.tool_calls ?? "?"} tools</div>
        <Show when={work().turn.active_tools.length}><div class="current-work-tools">{work().turn.active_tools.map((tool) => `${tool.name} (${tool.status})`).join(", ")}</div></Show>
        <div class="ctx-caption" data-summary-status={summary()?.status}>
          summary {summary()?.status ?? "unavailable"}{age() ? ` · ${age()} old` : ""}
          <Show when={summary()?.text && (summary()?.status === "ready" || summary()?.status === "stale")}>: {summary()?.text}</Show>
        </div>
        <Show when={summary()?.status !== "ready"}>
          <button type="button" class="current-work-generate" onClick={() => currentWork(props.id, props.directory, true)}>Generate summary</button>
        </Show>
        <Show when={snapshot().error || now() - snapshot().checked > (work().turn.status === "busy" ? 15_000 : 45_000)}>
          <div class="ctx-caption">telemetry last checked {elapsed(Math.max(0, Math.floor((now() - snapshot().checked) / 1000)))} ago</div>
        </Show>
      </>}
    </Show>
  </section>
}

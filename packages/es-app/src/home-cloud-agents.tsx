import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { es, type WingmanLane, type WingmanTranscript } from "./api"
import type { HomeActivityRow } from "./home-activity-data"
import { ago, useDashboard } from "./state"
import { wingmanStatus } from "./wingman"

type Pin = { editspace: string; lane: string; owner: string }
type Snapshot = { lanes: WingmanLane[]; checked: number; error: string }
const key = (pin: Pin) => JSON.stringify([pin.editspace, pin.lane, pin.owner])
const storageKey = "es-app-cloud-pins"
const maxScopes = 5

const readPins = (): Pin[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]")
    if (!Array.isArray(value)) return []
    return [...new Map(value.filter((item): item is Pin =>
      item !== null && typeof item === "object" &&
      typeof item.editspace === "string" && !!item.editspace &&
      typeof item.lane === "string" && !!item.lane &&
      typeof item.owner === "string" && !!item.owner,
    ).map(item => [key(item), { editspace: item.editspace, lane: item.lane, owner: item.owner }])).values()]
  } catch { return [] }
}

const githubPr = (value: string) => {
  const url = URL.parse(value)
  return url?.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.port &&
    /^\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(url.pathname) ? url.href : undefined
}
const runtimeLink = (value?: string) => {
  const url = URL.parse(value ?? "")
  return url?.protocol === "https:" && !url.username && !url.password && !!url.hostname && !url.port ? url.href : undefined
}

const Transcript = (props: { pin: Pin }) => {
  const [open, setOpen] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [result, setResult] = createSignal<WingmanTranscript>()
  const [error, setError] = createSignal("")
  let controller: AbortController | undefined
  onCleanup(() => controller?.abort())
  const toggle = () => {
    if (open()) { controller?.abort(); setLoading(false); setOpen(false); return }
    setOpen(true)
    setResult(undefined)
    setError("")
    setLoading(true)
    const request = new AbortController()
    controller = request
    void es.wingmanTranscript(props.pin.lane, props.pin.editspace, request.signal).then(value => {
      if (!request.signal.aborted) setResult(value)
    }).catch(() => {
      if (!request.signal.aborted) setError("Transcript unavailable (gateway or VPN). Try again later.")
    }).finally(() => { if (!request.signal.aborted) setLoading(false) })
  }
  return <div><button onClick={toggle}>{open() ? "Close transcript" : "Load transcript"}</button>
    <Show when={open()}><div class="home-source">On-demand gateway transcript · untrusted text</div>
      <Show when={loading()}><p class="home-muted">Loading transcript…</p></Show>
      <Show when={error()}><p class="home-muted" role="status">{error()}</p></Show>
      <Show when={result()}>{transcript => <div>
        <div class="home-source">Gateway status: <bdi dir="auto">{transcript().status ?? "unknown"}</bdi> · turns dropped: {transcript().turns_dropped ?? "unknown"}</div>
        <For each={transcript().turns ?? []} fallback={<p class="home-muted">No turns returned.</p>}>{(turn, index) => <div>
          <div class="home-source">Turn {index() + 1} · <bdi dir="auto">{turn.status ?? "status unknown"}</bdi></div>
          <Show when={turn.prompt}><pre dir="auto">{turn.prompt}</pre></Show>
          <Show when={turn.output}><pre dir="auto">{turn.output}</pre></Show>
          <For each={turn.events ?? []}>{event => <div><span class="home-source"><bdi dir="auto">{event.type ?? "event"}</bdi></span><pre dir="auto">{event.text ?? ""}</pre></div>}</For>
        </div>}</For>
      </div>}</Show>
    </Show>
  </div>
}

export default function HomeCloudAgents(props: { project?: string; onCount: (n: number) => void; onActivity: (rows: HomeActivityRow[]) => void }) {
  const dashboard = useDashboard()
  const [pins, setPins] = createSignal(readPins())
  const [snapshots, setSnapshots] = createSignal<Record<string, Snapshot>>({})
  const [now, setNow] = createSignal(Date.now())
  const [loading, setLoading] = createSignal(false)
  const [pinError, setPinError] = createSignal("")
  const visiblePins = () => pins().filter(pin => !props.project || pin.editspace === props.project)
  const selected = () => props.project ?? dashboard.editspace() ?? dashboard.editspaces()?.default ?? undefined
  // Selected discovery plus at most four other explicitly pinned projects; no registry-wide scan.
  const scopes = createMemo(() => [...new Set([selected(), ...visiblePins().map(pin => pin.editspace)].filter((name): name is string => !!name))].slice(0, maxScopes))
  const observed = createMemo(() => scopes().flatMap(editspace => (snapshots()[editspace]?.lanes ?? [])
    .filter(lane => !!lane.lane && !!lane.owner).map(lane => ({ editspace, lane: lane.lane!, owner: lane.owner!, record: lane }))))
  const pinned = createMemo(() => visiblePins().map(pin => ({ ...pin, record: observed().find(item => key(item) === key(pin))?.record,
    snapshot: snapshots()[pin.editspace], inScope: scopes().includes(pin.editspace) })))
  const other = createMemo(() => observed().filter(item => !pins().some(pin => key(pin) === key(item))))
  const updatePins = (next: Pin[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setPins(next); setPinError("") }
    catch { setPinError("Cloud pin could not be saved. Existing pins were kept.") }
  }
  let generation = 0
  const refresh = async (names: string[]) => {
    const current = ++generation
    setLoading(true)
    const result = await Promise.all(names.map(async name => {
      try {
        const value = await es.wingman(name)
        if (value.error) throw new Error(value.error)
        if (!Array.isArray(value.lanes)) throw new Error("Invalid lane snapshot")
        return { name, snapshot: { lanes: value.lanes, checked: Date.now(), error: "" } }
      } catch { return { name, snapshot: { error: "Cloud lane source unavailable; last-known snapshot retained." } } }
    }))
    if (current !== generation) return
    setSnapshots(previous => Object.fromEntries([...Object.entries(previous), ...result.map(item => [item.name, {
      lanes: "lanes" in item.snapshot ? item.snapshot.lanes : previous[item.name]?.lanes ?? [],
      checked: "checked" in item.snapshot ? item.snapshot.checked : previous[item.name]?.checked ?? 0,
      error: item.snapshot.error,
    }])]))
    setLoading(false)
  }
  createEffect(() => { const names = scopes(); if (names.length) void refresh(names) })
  onMount(() => {
    const interval = setInterval(() => { setNow(Date.now()); if (scopes().length) void refresh(scopes()) }, 60_000)
    onCleanup(() => { clearInterval(interval); generation++ })
  })
  createEffect(() => props.onCount(visiblePins().length))
  createEffect(() => props.onActivity(pinned().flatMap(item => {
    if (!item.record || !item.snapshot?.checked) return []
    return [{ id: `cloud:${key(item)}`, level: "minor" as const, kind: "cloud" as const,
      text: `${item.editspace} · ${item.lane} · ${wingmanStatus(item.record["wingman-status"]).label} (self-reported lane record)`,
      time: item.snapshot.checked, timeLabel: "snapshot observed", source: `${item.editspace} · cloud lane record · report age unknown${item.snapshot.error ? " · source unavailable" : ""}`,
      sourceAt: item.snapshot.checked }]
  })))
  const age = (checked?: number) => { now(); return checked ? `checked ${ago(checked)}` : "never checked" }

  return <section aria-label="Cloud agents"><div class="home-section"><h2>Cloud agents <span>{visiblePins().length}</span></h2><span class="home-muted">Pinned lane owners only · read-only snapshots</span></div>
    <Show when={pinError()}><p class="home-source" role="status">{pinError()}</p></Show>
    <div class="home-actions"><button disabled={loading() || !scopes().length} onClick={() => void refresh(scopes())}>Refresh cloud lanes</button></div>
    <Show when={loading()}><p class="home-source">Checking bounded cloud lane sources…</p></Show>
    <Show when={!scopes().length}><p class="home-muted">No selected project available for cloud discovery.</p></Show>
    <Show when={pins().some(pin => !scopes().includes(pin.editspace))}><p class="home-source">At most {maxScopes} projects are checked. Additional pinned projects remain saved but are not observed.</p></Show>
    <For each={scopes().filter(name => snapshots()[name]?.error)}>{name => <p class="home-source" role="status"><bdi dir="auto">{name}</bdi>: {snapshots()[name].error} {age(snapshots()[name].checked)}</p>}</For>
    <For each={visiblePins()} fallback={<p class="home-muted">No cloud tasks pinned. Expand Other cloud tasks to pin an observed owner.</p>}>{pin => {
      const item = { ...pin, get record() { return observed().find(value => key(value) === key(pin))?.record }, get snapshot() { return snapshots()[pin.editspace] }, get inScope() { return scopes().includes(pin.editspace) } }
      return <div class="home-agent">
      <div><strong class="home-name"><bdi dir="auto">{item.lane}</bdi></strong><div class="home-muted"><bdi dir="auto">{item.editspace} · {item.owner}</bdi></div><button onClick={() => updatePins(pins().filter(pin => key(pin) !== key(item)))}>Unpin</button></div>
      <div><Show when={item.record} fallback={<p class="home-muted">Stale · pinned owner no longer observed{item.inScope && !item.snapshot?.error && item.snapshot?.checked ? " in the latest snapshot" : "; source not checked"}. {age(item.snapshot?.checked)} · report age unknown</p>}>{lane => <>
        <div><span class={`chip ${wingmanStatus(lane()["wingman-status"]).chip}`}>{wingmanStatus(lane()["wingman-status"]).label}</span> <bdi dir="auto">{lane().activity || lane().issue || "Activity not reported"}</bdi></div>
        <div class="home-source">Self-reported lane record · {age(item.snapshot?.checked)} · report age unknown{item.snapshot?.error ? " · source unavailable; last-known snapshot" : ""}</div>
        <div class="home-muted">Reported turns: <bdi dir="auto">{lane()["wingman-turns"] ?? "unknown"}</bdi> · reported cost: <bdi dir="auto">{lane()["wingman-cost"] ?? "unknown"}</bdi></div>
        <div class="home-actions"><For each={(lane()["wingman-prs"] ?? "").split(/\s+/).map(githubPr).filter((url): url is string => !!url)}>{url => <a href={url} target="_blank" rel="noopener noreferrer">PR <bdi dir="ltr">{url}</bdi></a>}</For>
          <Show when={runtimeLink(lane()["wingman-url"])}>{url => <a href={url()} target="_blank" rel="noopener noreferrer">Runtime workflow</a>}</Show></div>
        <Transcript pin={item} />
      </>}</Show></div>
    </div>}}</For>
    <details class="home-workers"><summary>Other cloud tasks ({other().length})</summary><div class="home-source">Selected project discovery and explicitly pinned projects only. Lane status is self-reported, not live gateway execution.</div>
      <For each={other()}>{item => <div class="home-other"><span><bdi dir="auto">{item.editspace} · {item.lane} · {item.owner}</bdi> · {wingmanStatus(item.record["wingman-status"]).label} <span class="home-source">({age(snapshots()[item.editspace]?.checked)} · report age unknown)</span></span><button onClick={() => updatePins([...pins(), { editspace: item.editspace, lane: item.lane, owner: item.owner }])}>Pin</button></div>}</For>
    </details>
  </section>
}

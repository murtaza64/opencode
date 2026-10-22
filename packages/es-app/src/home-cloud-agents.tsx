import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { es, type WingmanTranscript } from "./api"
import { cloudKey, cloudOwnerKnown, type CloudPin, type createCloudAgents } from "./cloud-agents"
import { ago, useDashboard } from "./state"
import { wingmanRunUrl, wingmanStatus, wingmanSyncedAt } from "./wingman"
import { FindExcerpt, TranscriptFind } from "./components/transcript-find"
import type { FindHit } from "./transcript-find"

const githubPr = (value: string) => {
  const url = URL.parse(value)
  return url?.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.port &&
    /^\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(url.pathname) ? url.href : undefined
}
const runtimeLink = (value?: string) => {
  const url = URL.parse(value ?? "")
  return url?.protocol === "https:" && !url.username && !url.password && !!url.hostname && !url.port ? url.href : undefined
}

const Transcript = (props: { pin: CloudPin; available: () => boolean; findable?: boolean }) => {
  const cloud: ReturnType<typeof createCloudAgents> = useDashboard().cloud
  const [open, setOpen] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [result, setResult] = createSignal<WingmanTranscript>()
  const [error, setError] = createSignal("")
  const [finding, setFinding] = createSignal(false)
  const [hit, setHit] = createSignal<FindHit>()
  let container: HTMLDivElement | undefined
  let focus: Element | null = null
  const openFind = () => {
    if (!result() || !open()) return
    if (finding()) { container?.querySelector<HTMLInputElement>("[data-transcript-find] input")?.focus({ preventScroll: true }); return }
    focus = document.activeElement
    setFinding(true)
  }
  const closeFind = () => {
    setFinding(false)
    setHit(undefined)
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true })
  }
  onMount(() => {
    if (!props.findable) return
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || !result() || !open()) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault()
        event.stopImmediatePropagation()
        openFind()
      }
      if (finding() && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeFind() }
    }
    window.addEventListener("keydown", keydown, true)
    onCleanup(() => window.removeEventListener("keydown", keydown, true))
  })
  createEffect(() => { if (!result() || !open()) { setFinding(false); setHit(undefined) } })
  let controller: AbortController | undefined
  let identity = cloudKey(props.pin)
  onCleanup(() => controller?.abort())
  createEffect(() => {
    const next = cloudKey(props.pin)
    if (identity === next) return
    identity = next
    controller?.abort()
    setOpen(false)
    setLoading(false)
    setResult(undefined)
    setError("")
  })
  createEffect(() => { if (!props.available()) { controller?.abort(); setOpen(false); setLoading(false); setResult(undefined) } })
  const toggle = async () => {
    if (open()) { controller?.abort(); setLoading(false); setOpen(false); return }
    if (!props.available()) return
    setOpen(true)
    setResult(undefined)
    setError("")
    setLoading(true)
    const request = new AbortController()
    const pin = { ...props.pin }
    controller = request
    const checked = Date.now()
    await cloud.refresh([pin.editspace])
    if (request.signal.aborted) return
    if (!props.available() || cloudKey(props.pin) !== cloudKey(pin) || (cloud.snapshots()[pin.editspace]?.checked ?? 0) < checked) {
      setLoading(false)
      setError("Pinned owner could not be verified from the cloud lane source.")
      return
    }
    void es.wingmanTranscript(pin.lane, pin.editspace, request.signal, pin.owner).then(value => {
      if (value.owner !== pin.owner) throw new Error("owner-mismatch")
      if (!request.signal.aborted) setResult(value)
    }).catch(error => {
      if (!request.signal.aborted) setError(error instanceof Error && error.message === "owner-mismatch" ? "Transcript owner changed or could not be verified. Nothing was displayed." : "Transcript unavailable. Try again later.")
    }).finally(() => { if (!request.signal.aborted) setLoading(false) })
  }
  return <div ref={container}><button onClick={toggle}>{open() ? "Close transcript" : "Load transcript"}</button>
    <Show when={props.findable}><button disabled={!open() || !result()} title="Load the gateway transcript before finding text" onClick={openFind}>Find in loaded transcript</button></Show>
    <Show when={finding() && result()}>{transcript => <TranscriptFind
      documents={(transcript().turns ?? []).flatMap((turn, index) => [
        { kind: "gateway prompt", text: turn.prompt }, { kind: "gateway reply", text: turn.reply },
        { kind: "gateway error", text: typeof turn.error === "string" ? turn.error : undefined },
      ].flatMap((part, partIndex) => part.text ? [{ messageID: `Turn ${index + 1}`, partID: `turn_${index}_${partIndex}`, role: "gateway", kind: part.kind, text: part.text }] : []))}
      scopeLabel="Loaded gateway transcript only"
      scopeDescription="Literal, case-insensitive gateway prompt/reply/error text. Excludes events, reasoning and internal payloads. The gateway may drop turns; earlier or unloaded turns are not searched. No local Session API is used."
      clear={() => setHit(undefined)} close={closeFind} jump={(hit) => {
        setHit(hit)
        requestAnimationFrame(() => {
          const target = [...(container?.querySelectorAll<HTMLElement>("[data-cloud-find-turn]") ?? [])]
            .find((element) => element.dataset.cloudFindTurn === hit.messageID)
          target?.scrollIntoView({ block: "start", inline: "nearest" })
        })
      }} />}</Show>
    <Show when={open()}><div class="home-source">On-demand gateway transcript · untrusted text</div>
      <Show when={loading()}><p class="home-muted">Loading transcript…</p></Show>
      <Show when={error()}><p class="home-muted" role="status">{error()}</p></Show>
      <Show when={result()}>{transcript => <div>
        <div class="home-source">Gateway status: <bdi dir="auto">{transcript().status ?? "unknown"}</bdi> · turns dropped: {transcript().turns_dropped ?? "unknown"}</div>
        <For each={transcript().turns ?? []} fallback={<p class="home-muted">No turns returned.</p>}>{(turn, index) => <div data-cloud-find-turn={`Turn ${index() + 1}`}>
          <Show when={hit()?.messageID === `Turn ${index() + 1}` ? hit() : undefined}>{hit =>
            <div class="find-jump" role="region" aria-label="Selected transcript match"><FindExcerpt hit={hit()} /></div>
          }</Show>
          <div class="home-source">Turn {index() + 1} · <bdi dir="auto">{turn.status ?? "status unknown"}</bdi></div>
          <Show when={turn.prompt}><pre dir="auto">{turn.prompt}</pre></Show>
          <Show when={turn.reply}><pre dir="auto">{turn.reply}</pre></Show>
          <Show when={turn.error}><pre dir="auto">{typeof turn.error === "string" ? turn.error : JSON.stringify(turn.error)}</pre></Show>
          <For each={turn.events ?? []}>{event => <div><span class="home-source"><bdi dir="auto">{event.kind ?? "event"}{event.tool_name ? ` · ${event.tool_name}` : ""}</bdi></span><pre dir="auto">{event.text ?? ""}</pre></div>}</For>
        </div>}</For>
      </div>}</Show>
    </Show>
  </div>
}

export const CloudAgentDetails = (props: { pin: CloudPin }) => {
  const cloud: ReturnType<typeof createCloudAgents> = useDashboard().cloud
  const snapshot = () => cloud.snapshots()[props.pin.editspace]
  const inScope = () => cloud.scopes().includes(props.pin.editspace)
  const record = () => cloud.allPinned().find(item => cloudKey(item.pin) === cloudKey(props.pin))?.record ??
    cloud.observed().find(item => cloudKey(item) === cloudKey(props.pin))?.record
  const pinned = () => cloud.pins().some(item => cloudKey(item) === cloudKey(props.pin))
  const age = () => { cloud.now(); return snapshot()?.checked ? `checked ${ago(snapshot()!.checked)}` : "never checked" }

  return <section class="home-agent" aria-label="Cloud agent details">
    <div><strong class="home-name"><bdi dir="auto">{props.pin.lane}</bdi></strong>
      <div class="home-muted"><bdi dir="auto">{props.pin.editspace} · {props.pin.owner}</bdi></div>
      <button disabled={!pinned() && (!record() || !cloudOwnerKnown(props.pin.owner))} onClick={() => cloud.togglePin(props.pin)}>{pinned() ? "Unpin" : "Pin"}</button>
      <Show when={cloud.pinError()}><p class="home-source" role="status">{cloud.pinError()}</p></Show>
    </div>
    <div>
      <Show when={snapshot()?.error}><p class="home-source" role="status">{snapshot()?.error} {age()}</p></Show>
      <Show when={record()} fallback={<p class="home-muted">{!inScope() || !snapshot()?.checked || snapshot()?.error
        ? "Cloud lane source unknown; pinned owner cannot be verified."
        : "Pinned owner missing from latest cloud lane snapshot."} {age()} · report age unknown</p>}>{lane => <>
        <div><span class={`chip ${wingmanStatus(lane()["wingman-status"]).chip}`}>{wingmanStatus(lane()["wingman-status"]).label}</span> <bdi dir="auto">{lane().activity || lane().issue || "Activity not reported"}</bdi></div>
        <div class="home-source">Lane record snapshot · {age()} · {wingmanSyncedAt(lane()) ? `Wingman synced ${ago(wingmanSyncedAt(lane()))}` : "not synced yet; report age unknown"}{snapshot()?.error ? " · source unavailable; last-known snapshot" : ""}</div>
        <Show when={lane()["wingman-error"]}><p class="home-warning"><bdi dir="auto">{lane()["wingman-error"]}</bdi></p></Show>
        <div class="home-muted">Reported turns: <bdi dir="auto">{lane()["wingman-turns"] ?? "unknown"}</bdi> · reported cost: <bdi dir="auto">{lane()["wingman-cost"] ?? "unknown"}</bdi></div>
        <div class="home-actions"><For each={(lane()["wingman-prs"] ?? "").split(/\s+/).map(githubPr).filter((url): url is string => !!url)}>{url => <a href={url} target="_blank" rel="noopener noreferrer">PR <bdi dir="ltr">{url}</bdi></a>}</For>
          <Show when={runtimeLink(wingmanRunUrl(lane()))}>{url => <a href={url()} target="_blank" rel="noopener noreferrer">Runtime workflow</a>}</Show><Show when={lane()["wingman-ci"]}><span class="home-source">CI: {lane()["wingman-ci"]}</span></Show></div>
        <Show when={!snapshot()?.error && inScope() && cloudOwnerKnown(props.pin.owner)}><Transcript pin={props.pin} available={() => !!record() && !snapshot()?.error && inScope()} findable /></Show>
      </>}</Show>
    </div>
  </section>
}

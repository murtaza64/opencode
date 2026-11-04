/* Another Work host's entry opened in this window (Main1555): its decision, permission, question or Surface, read
 * and acted on through the Local listener's /hosts/<id>/ routes (host-items.ts), so the action happens on the
 * owning host with that host's operator session and the window never switches to that host's tab. */
import { SurfaceChangeNote } from "./surface-change-note"
import { CitedRevisionGate } from "./cited-revision"
import { createResource, createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { A } from "@solidjs/router"
import { createAttention } from "../attention"
import { attentionItem, briefCopy, briefSends } from "../desk"
import { briefAnchorID, createBriefs, type DeskPointer } from "../desk-session"
import { hostCore, hostPrefix, hostSurfaceAddress, markHostDeliverable, readHostDecision, readHostRequest } from "../host-items"
import { ago, useDashboard } from "../state"
import type { WorkEntry } from "../work-queue"
import { AttentionDecision, decisionState } from "./attention-decision"
import { PreparedBrief, useCompleteBrief, useCompleteJob } from "./attention-brief"
import { HomePermission } from "./home-permission"
import { HostGlyph } from "./icons"
import { AppHeader } from "./native-header"
import { SurfaceOwner } from "./surface-owner"
import { createDeliverableDone, DeliverableDoneControls, SurfaceHeadMore } from "./desk-surfaces"
import { SurfaceComments } from "./surface-comments"
import { esSurfaceHost } from "../surface-comments"
import { useDeskQueue } from "../desk-queue"
import { artifactSurface, staleArtifact } from "../needs-you"
import type { Surface } from "../surfaces"

// The parent may clear the entry while this view (and its portalled top-bar row) is still being disposed.
export const WorkRemoteDetail = (props: { entry: WorkEntry; cited?: number; onClose: () => void }) => {
  const host = () => props.entry?.host ?? ""
  const where = () => <span class="work-remote-host" data-host={host()}><HostGlyph host={host()} size={12} /> on <bdi dir="auto">{props.entry?.hostLabel ?? host()}</bdi>
    <Show when={props.entry?.stale}> · <span class="home-blocked">{props.entry?.unavailableReason ? "unreachable · last known" : "last known"}</span></Show></span>
  const surface = () => props.entry?.remote?.kind === "surface"
  return <section class="desk-evidence attention-home work-remote" aria-label="Selected item" data-work-key={props.entry?.key} data-remote-kind={props.entry?.remote?.kind}
    onKeyDown={event => { if (surface() && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); props.onClose() } }}>
    {/* A Surface carries its own compact bar (host included); other items keep the Close + host head. */}
    <Show when={!surface()}><div class="desk-evidence-head">
      <button class="desk-button" aria-label="Close" onClick={props.onClose}>Close</button>
      {where()}
    </div></Show>
    <Switch>
      <Match when={props.entry?.remote?.kind === "attention" ? props.entry.remote : undefined}>{remote => <RemoteDecision host={host()} record={remote().record} />}</Match>
      <Match when={props.entry?.remote?.kind === "request" ? props.entry.remote : undefined}>{remote => <RemoteRequest host={host()} label={props.entry.hostLabel ?? host()} request={remote().request} stale={props.entry.stale} />}</Match>
      <Match when={props.entry?.remote?.kind === "surface" ? props.entry.remote : undefined}>{remote => <RemoteSurface host={host()} label={props.entry.hostLabel ?? host()} surface={remote().surface} frame={remote().frame} cited={props.cited} onClose={props.onClose} />}</Match>
    </Switch>
  </section>
}

// The decision as that host has it now, answered with that host's operator session.
export const RemoteDecision = (props: { host: string; record: NonNullable<Extract<WorkEntry["remote"], { kind: "attention" }>>["record"] }) => {
  const attention = createAttention(() => props.record.editspace, { prefix: hostPrefix(props.host) })
  // The ledger's record route answers { record, events }; take the record (RHC readHostDecision returns the body as is).
  const [fresh] = createResource(() => props.record, async record => {
    const body: unknown = await readHostDecision(props.host, record)
    return body && typeof body === "object" && "record" in body ? (body as { record: typeof record }).record : body as typeof record | undefined
  })
  const current = () => attention.snapshot()?.value.records.find(record => record.id === props.record.id) ?? fresh() ?? props.record
  const [anchors] = createResource(() => props.host, async host => {
    const response = await fetch(`${hostPrefix(host)}/es/api/editspaces`, { credentials: "include" })
    if (!response.ok) throw new Error(`Could not read ${host}'s projects (HTTP ${response.status})`)
    // A listener that answers this route with a page (an older or refusing one) gets the same message, not a parse error.
    const body = response.headers.get("content-type")?.includes("application/json")
      ? await response.json().catch(() => undefined) as { editspaces?: { root: string }[] } | undefined : undefined
    if (!Array.isArray(body?.editspaces)) throw new Error(`Could not read ${host}'s projects (not a project list)`)
    return Promise.all(body.editspaces.map(async project => ({ session: await briefAnchorID(project.root), directory: project.root })))
  })
  return <Show when={!fresh.error || attention.snapshot()} fallback={<p class="desk-surface-state" role="alert">{String(fresh.error?.message ?? fresh.error)}</p>}>
    <Show when={fresh.loading || fresh() !== undefined || attention.snapshot()} fallback={<p class="desk-surface-state">This decision is no longer on that host.</p>}>
      <Show when={anchors()} fallback={<AttentionDecision record={current()} attention={attention} remote host={props.host} />}>{pointers =>
        <RemotePreparedDecision host={props.host} record={current} attention={attention} anchors={pointers()} />}</Show>
    </Show>
  </Show>
}

const RemotePreparedDecision = (props: { host: string; record: () => NonNullable<Extract<WorkEntry["remote"], { kind: "attention" }>>["record"]; attention: ReturnType<typeof createAttention>; anchors: DeskPointer[] }) => {
  // This reader has no anchor creation, pending local job or start path. Every request uses the owning host's Core.
  const briefs = createBriefs(() => undefined, () => undefined, undefined, () => props.anchors, { client: hostCore(props.host), readOnly: true, prefix: hostPrefix(props.host) })
  const item = () => attentionItem(props.record(), 0)
  const job = useCompleteJob(item, undefined, briefs.jobs)
  const brief = useCompleteBrief(item, undefined, briefs.jobs)
  const sends = () => { const value = brief(); return value ? { text: briefSends(value, item()), to: value.sendsTo, as: value.sendsAs } : undefined }
  const copy = () => { const value = brief(); return value ? briefCopy(value, item()) : undefined }
  const part = (slot: "lead" | "visual" | "after" | "details") => <PreparedBrief item={item()} live={false} part={slot} jobs={briefs.jobs} host={props.host} />
  // No complete brief yet: the owning host's dashboard makes one there (operator only); this view rereads that host's briefs.
  const running = () => briefs.jobs().some(entry => entry.meta.source === item().key && entry.meta.revision === item().revision && (entry.state.state === "running" || entry.state.state === "starting"))
  const request = () => <Show when={!brief() && item().kind !== "review" && !item().series && !props.record().series}><p class="desk-brief-regenerate">
    <Show when={!briefs.regenerating() && !running()} fallback={<span class="home-muted" role="status">Preparing brief on that host…</span>}>
      <button type="button" class="desk-link-button" onClick={() => void briefs.regenerate(item())}>Request brief</button></Show>
    <Show when={briefs.error().startsWith("Brief not regenerated") ? briefs.error() : ""}>{message => <span class="home-muted" role="alert"> {message()}</span>}</Show></p></Show>
  return <AttentionDecision record={props.record()} attention={props.attention} remote host={props.host} prepared={brief()}
    briefJob={job() ? { job: job()!.id, revision: job()!.meta.revision } : undefined} sends={sends()} copy={copy()}
    brief={<>{part("lead")}{request()}</>} briefVisual={part("visual")} briefAfter={part("after")} briefDetails={part("details")} />
}

// A pending request, validated against that host's Core before any control is offered; gone means its outcome is unknown.
const RemoteRequest = (props: { host: string; label: string; request: NonNullable<Extract<WorkEntry["remote"], { kind: "request" }>>["request"]; stale: boolean }) => {
  const [pending, { refetch }] = createResource(() => props.request, request => readHostRequest(props.host, request))
  const thread = () => `/session/${encodeURIComponent(props.request.session)}?directory=${encodeURIComponent(props.request.directory)}&host=${encodeURIComponent(props.host)}`
  return <Show when={!pending.loading} fallback={<p class="desk-surface-state">Checking on <bdi dir="auto">{props.label}</bdi>…</p>}>
    <Show when={!pending.error} fallback={<div class="desk-surface-state" role="alert"><p>Cannot check this request on <bdi dir="auto">{props.label}</bdi>: {String(pending.error?.message ?? pending.error)}</p><button class="desk-button" onClick={() => void refetch()}>Try again</button></div>}>
      <Show when={pending()} fallback={<div class="desk-surface-state"><p>No longer pending on <bdi dir="auto">{props.label}</bdi>; its outcome is not known here.</p><A href={thread()}>Open thread</A></div>}>
        {live => <Show when={props.request.kind === "permission"} fallback={
          <div class="home-request" data-request-id={props.request.id}><div><h3><bdi dir="auto">{props.request.title}</bdi></h3><div class="home-source">Answer it in its thread.</div></div>
            <A href={thread()}>Open thread</A></div>}>
          <HomePermission item={{ ...props.request, state: "pending", checked: Date.now(), permission: live() as PermissionRequest }}
            live="pending" siblings={0} stale={props.stale} core={hostCore(props.host)} onReceipt={() => undefined} onRecheck={async () => { await refetch() }} />
        </Show>}
      </Show>
    </Show>
  </Show>
}

// A file Surface frames through the owning host; a URL Surface is served only on its own host for now (502 here).
const RemoteSurface = (props: { host: string; label: string; surface: NonNullable<Extract<WorkEntry["remote"], { kind: "surface" }>>["surface"]; frame: "host" | "own-host-only"; cited?: number; onClose: () => void }) => {
  const [address, { refetch }] = createResource(() => props.frame === "host" ? props.surface.id : undefined, id => hostSurfaceAddress(props.host, id))
  const src = () => address.error ? undefined : address()?.src
  // Done/Undo write that host's seen state only, then reread that host's list so its Needs you rows follow.
  const work = useDashboard().work
  // A link surface this window cannot frame opens on its own host (that host's reader, its own tab).
  const onHost = () => { const origin = work.host(props.host)?.origin; return origin ? `${origin}/?surface=${encodeURIComponent(props.surface.id)}` : undefined }
  const [opened, setOpened] = createSignal(false)
  // Done covers only what was shown: a framed surface once its frame has its address; a link surface once the human
  // opened it on its host from this reader. None for a failed address or before load.
  const viewed = () => props.frame === "host" ? !!src() : opened()
  const done = createDeliverableDone(() => props.surface, () => viewed() ? async (surface, revision, seen) => {
    const ok = await markHostDeliverable(props.host, surface, revision, seen)
    if (ok) await work.feeds().find(feed => feed.host.id === props.host)?.load()
    return ok
  } : undefined)
  return <div class="desk-surface work-remote-surface">
    <AppHeader>
      <div class="surface-head" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); props.onClose() } }}>
        <h2 title={`${props.surface.owner} · updated ${ago(props.surface.updated_at)}`}><bdi dir="auto">{props.surface.title}</bdi></h2>
        <span class="surface-head-rev">rev {done.onScreen() || props.surface.revision}</span>
        <SurfaceOwner surface={props.surface} host={{ id: props.host, label: props.label }} onMessage={() => window.dispatchEvent(new CustomEvent("surface-message-author", { detail: props.surface.id }))} />
        <DeliverableDoneControls state={done} label={props.frame === "host" ? undefined : `Mark seen (opened on ${props.label})`} />
        <SurfaceHeadMore surface={props.surface} src={() => props.frame === "host" ? src() : undefined} done={done} />
        <span class="surface-head-actions">
          <button class="surface-head-button" aria-label="Close" title="Close (Esc)" onClick={props.onClose}>×</button>
        </span>
      </div>
    </AppHeader>
    <Show when={done.onScreen() ? `${props.surface.id}:${done.onScreen()}` : undefined} keyed>{_key =>
      <SurfaceChangeNote surface={props.surface} host={props.host} revision={done.onScreen()} />}</Show>
    <LinkedDecisions surface={props.surface} host={props.host} />
    <Show when={props.frame === "host"} fallback={<p class="desk-surface-state" data-surface-gap="own-host-only">This link surface is served only on <bdi dir="auto">{props.label}</bdi>; it cannot be shown from another computer yet.
      <Show when={onHost()}>{href => <> <a class="desk-link-button" href={href()} target="_blank" rel="noopener noreferrer" data-open-on-host={props.host} onClick={() => { setOpened(true); done.used() }}>Open on <bdi dir="auto">{props.label}</bdi></a></>}</Show></p>}>
      <Show when={!address.error} fallback={<div class="desk-surface-state" role="alert"><p>Cannot open this surface from <bdi dir="auto">{props.label}</bdi>: {String(address.error?.message ?? address.error)}</p><button class="desk-button" onClick={() => void refetch()}>Try again</button></div>}>
        {/* Remounts when the human loads a newer revision, so Done covers what is on screen. */}
        <CitedRevisionGate cited={props.cited} current={props.surface.revision}>
        <Show when={src() ? `${src()}|${done.onScreen()}` : undefined} keyed fallback={<p class="desk-surface-state">Loading…</p>}>{_key => {
          const [frame, setFrame] = createSignal<HTMLIFrameElement>()
          let stage: HTMLDivElement | undefined
          return <div class="surface-stage" ref={stage}>
            <iframe ref={setFrame} class="desk-surface-frame" title={props.surface.title} src={src()} referrerpolicy="no-referrer"
              onLoad={() => void done.loaded(() => work.feeds().find(feed => feed.host.id === props.host)?.load() ?? Promise.resolve())}
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" />
            {/* Comments live on the host that owns the Surface, with that host's operator session. */}
            <SurfaceComments host={esSurfaceHost(props.surface.id, hostPrefix(props.host))} surface={props.surface} ownerHost={{ id: props.host, label: props.label }} revision={done.onScreen()} frame={frame} stage={() => stage} />
          </div>
        }}</Show>
        </CitedRevisionGate>
      </Show>
    </Show>
  </div>
}

/** The decisions that explicitly point at this Surface (`artifact.surface`), answered here with the same native controls
 * as their own card (DD artifact-try-decision-unification). Open ones first; with none open, the latest that ended, so
 * its outcome stays visible. Another host's come from that host's list and act on that host. Nothing is merged or rewritten.
 * Compact by default (DD surface-decision-focus-compact-drawing): a one-line banner keeps the Surface primary and
 * expands the cards on demand. Expanding or hiding never answers. */
export const LinkedDecisions = (props: { surface: Surface; host?: string }) => {
  const queue = useDeskQueue()
  const work = useDashboard().work
  const records = () => {
    const about = (props.host
      ? work.feeds().find(feed => feed.host.id === props.host)?.state().decisions ?? []
      : queue.attention.snapshot()?.value.records ?? []).filter(record => artifactSurface(record) === props.surface.id)
    const open = about.filter(record => record.status === "open")
    return open.length ? open : about.toSorted((a, b) => b.updated_at - a.updated_at).slice(0, 1)
  }
  const key = () => `${props.host ?? ""}|${props.surface.id}`
  const [expanded, setExpanded] = createSignal(linkedExpanded.get(key()) ?? false)
  const toggle = () => { const next = !expanded(); linkedExpanded.set(key(), next); setExpanded(next) }
  const open = () => records().filter(record => record.status === "open").length
  const body = createUniqueId()
  return <Show when={records().length}>
    <aside class="surface-decisions attention-home" data-expanded={expanded() ? "" : undefined} aria-label={records().length === 1 ? "Decision about this" : `${records().length} decisions about this`}>
      <button type="button" class="surface-decisions-banner" aria-expanded={expanded()} aria-controls={body} onClick={toggle}>
        <span class="dot" classList={{ pending: open() > 0 }} aria-hidden="true" />
        <span class="surface-decisions-label">{records().length > 1 ? `${records().length} decisions` : open() ? "Decision" : decisionState(records()[0])}</span>
        <Show when={records().length === 1}><bdi dir="auto" class="surface-decisions-title">{records()[0].title}</bdi></Show>
        <span class="surface-decisions-toggle">{expanded() ? "Hide" : open() ? "Answer" : "Show"}</span>
      </button>
      {/* Hidden, not unmounted: a draft, caret or pending send in a card survives hiding it. */}
      <div id={body} class="surface-decisions-body" hidden={!expanded()}>
        {/* Keyed by record id, not object: every refresh delivers new record objects, and re-keying by object would
          * remount the card under the human's caret. The card gets the current record in place. */}
        <For each={records().map(record => record.id)}>{id => <Show when={records().find(record => record.id === id)}>{record =>
          <div class="surface-decision" data-attention-id={id}>
            <Show when={staleArtifact(record(), props.surface)}>{note => <p class="surface-decision-stale home-blocked" role="note">{note()} · showing rev {props.surface.revision}</p>}</Show>
            <Show when={props.host} fallback={<AttentionDecision record={record()} attention={queue.attention} />}>{host => <RemoteDecision host={host()} record={record()} />}</Show>
          </div>}</Show>}</For>
      </div>
    </aside>
  </Show>
}

// Whether the human last expanded a Surface's decisions, per host and Surface, for this window's lifetime.
const linkedExpanded = new Map<string, boolean>()

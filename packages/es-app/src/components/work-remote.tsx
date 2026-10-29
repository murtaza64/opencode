/* Another Work host's entry opened in this window (Main1555): its decision, permission, question or Surface, read
 * and acted on through the Local listener's /hosts/<id>/ routes (host-items.ts), so the action happens on the
 * owning host with that host's operator session and the window never switches to that host's tab. */
import { createResource, Match, Show, Switch } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { A } from "@solidjs/router"
import { createAttention } from "../attention"
import { hostCore, hostPrefix, hostSurfaceAddress, readHostDecision, readHostRequest } from "../host-items"
import { ago } from "../state"
import type { WorkEntry } from "../work-queue"
import { AttentionDecision } from "./attention-decision"
import { HomePermission } from "./home-permission"
import { HostGlyph } from "./icons"

export const WorkRemoteDetail = (props: { entry: WorkEntry; onClose: () => void }) => {
  const host = () => props.entry.host!
  const where = () => <span class="work-remote-host" data-host={host()}><HostGlyph host={host()} size={12} /> on <bdi dir="auto">{props.entry.hostLabel ?? host()}</bdi>
    <Show when={props.entry.stale}> · <span class="home-blocked">{props.entry.unavailableReason ? "unreachable · last known" : "last known"}</span></Show></span>
  return <section class="desk-evidence attention-home work-remote" aria-label="Selected item" data-work-key={props.entry.key}>
    <div class="desk-evidence-head">
      <button class="desk-button" aria-label="Close" onClick={props.onClose}>Close</button>
      {where()}
    </div>
    <Switch>
      <Match when={props.entry.remote?.kind === "attention" ? props.entry.remote : undefined}>{remote => <RemoteDecision host={host()} record={remote().record} />}</Match>
      <Match when={props.entry.remote?.kind === "request" ? props.entry.remote : undefined}>{remote => <RemoteRequest host={host()} label={props.entry.hostLabel ?? host()} request={remote().request} stale={props.entry.stale} />}</Match>
      <Match when={props.entry.remote?.kind === "surface" ? props.entry.remote : undefined}>{remote => <RemoteSurface host={host()} label={props.entry.hostLabel ?? host()} surface={remote().surface} frame={remote().frame} />}</Match>
    </Switch>
  </section>
}

// The decision as that host has it now, answered with that host's operator session.
const RemoteDecision = (props: { host: string; record: NonNullable<Extract<WorkEntry["remote"], { kind: "attention" }>>["record"] }) => {
  const attention = createAttention(() => props.record.editspace, { prefix: hostPrefix(props.host) })
  // The ledger's record route answers { record, events }; take the record (RHC readHostDecision returns the body as is).
  const [fresh] = createResource(() => props.record, async record => {
    const body: unknown = await readHostDecision(props.host, record)
    return body && typeof body === "object" && "record" in body ? (body as { record: typeof record }).record : body as typeof record | undefined
  })
  const current = () => attention.snapshot()?.value.records.find(record => record.id === props.record.id) ?? fresh() ?? props.record
  return <Show when={!fresh.error || attention.snapshot()} fallback={<p class="desk-surface-state" role="alert">{String(fresh.error?.message ?? fresh.error)}</p>}>
    <Show when={fresh.loading || fresh() !== undefined || attention.snapshot()} fallback={<p class="desk-surface-state">This decision is no longer on that host.</p>}>
      <AttentionDecision record={current()} attention={attention} remote />
    </Show>
  </Show>
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
const RemoteSurface = (props: { host: string; label: string; surface: NonNullable<Extract<WorkEntry["remote"], { kind: "surface" }>>["surface"]; frame: "host" | "own-host-only" }) => {
  const [address, { refetch }] = createResource(() => props.frame === "host" ? props.surface.id : undefined, id => hostSurfaceAddress(props.host, id))
  return <div class="desk-surface work-remote-surface">
    <h2><bdi dir="auto">{props.surface.title}</bdi></h2>
    <p class="home-source"><bdi dir="auto">{props.surface.owner}</bdi> · updated {ago(props.surface.updated_at)}</p>
    <Show when={props.frame === "host"} fallback={<p class="desk-surface-state" data-surface-gap="own-host-only">This link surface is served only on <bdi dir="auto">{props.label}</bdi>; it cannot be shown from another computer yet.</p>}>
      <Show when={!address.error} fallback={<div class="desk-surface-state" role="alert"><p>Cannot open this surface from <bdi dir="auto">{props.label}</bdi>: {String(address.error?.message ?? address.error)}</p><button class="desk-button" onClick={() => void refetch()}>Try again</button></div>}>
        <Show when={address()?.src} fallback={<p class="desk-surface-state">Loading…</p>}>{src =>
          <iframe class="desk-surface-frame" title={props.surface.title} src={src()} referrerpolicy="no-referrer"
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" />}</Show>
      </Show>
    </Show>
  </div>
}

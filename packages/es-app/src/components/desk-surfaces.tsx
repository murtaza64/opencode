/* Agent-owned surfaces in the Front Desk: a sidebar group above the queue and the selected
 * surface in the main panel. Content runs in the server-sandboxed frame; the desk renders
 * only the title, owner, update time and health that the registry reports. */
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref } from "../state"
import { renewDelay, surfaceAddress, surfaceKey, surfaceProblem, surfaceUnavailable, type Surface, type createSurfaces } from "../surfaces"
import { Glyph } from "./icons"
import "./desk-surfaces.css"

export const SurfaceList = (props: { surfaces: ReturnType<typeof createSurfaces>; selected?: string; onSelect: (key: string) => void }) => {
  const list = () => props.surfaces.boards()
  const allOffline = () => list().length > 0 && list().every(surfaceUnavailable)
  const rows = () => <ul class="desk-items">
    <For each={list()}>{surface =>
      <li><button class="desk-item desk-surface-row" aria-pressed={props.selected === surfaceKey(surface.id)} data-surface={surface.id}
        data-unavailable={surfaceUnavailable(surface) ? "" : undefined} onClick={() => props.onSelect(surfaceKey(surface.id))}>
        <bdi dir="auto" class="desk-item-title">{surface.title}</bdi>
        <span class="home-source"><bdi dir="auto">{surface.owner}</bdi> · {surfaceProblem(surface.health) ?? `updated ${ago(surface.updated_at)}`}</span>
      </button></li>}</For>
  </ul>
  return <Show when={list().length || (props.surfaces.error() && !props.surfaces.list().length)}>
    <section class="desk-surfaces" aria-label="Surfaces">
      {/* When nothing can be shown the group folds to one line, still openable. */}
      <Show when={allOffline()} fallback={<><h2>Surfaces</h2><Show when={list().length}>{rows()}</Show></>}>
        <details class="desk-surfaces-offline" open={list().some(surface => props.selected === surfaceKey(surface.id))}>
          <summary>Surfaces <span class="home-muted">· {list().length} offline</span></summary>
          {rows()}
        </details>
      </Show>
      <Show when={props.surfaces.error()}>{error => <p class="home-source home-blocked">{error()}</p>}</Show>
    </section>
  </Show>
}

/* Things the human asked for (reports, reviews), kept here so they are not lost in a chat.
 * New ones lead with a count; opened ones fold under Earlier. */
export const DeliverableList = (props: { surfaces: ReturnType<typeof createSurfaces>; selected?: string; onSelect: (key: string) => void }) => {
  const split = () => props.surfaces.deliverables()
  const row = (surface: Surface, fresh: boolean) =>
    <li><button class="desk-item desk-deliverable" aria-pressed={props.selected === surfaceKey(surface.id)} data-deliverable={surface.id}
      data-new={fresh ? "" : undefined} onClick={() => props.onSelect(surfaceKey(surface.id))}>
      <bdi dir="auto" class="desk-item-title">{surface.title}</bdi>
      <Show when={surface.summary}>{summary => <bdi dir="auto" class="desk-deliverable-preview">{summary()}</bdi>}</Show>
      <span class="home-source"><bdi dir="auto">{surface.owner}</bdi> · {ago(surface.created_at ?? surface.updated_at)}
        <Show when={surfaceProblem(surface.health)}>{problem => <> · <span class="home-blocked">{problem()}</span></>}</Show></span>
    </button></li>
  return <Show when={split().fresh.length || split().earlier.length}>
    <section class="desk-deliverables" aria-label="Requested">
      <h2>Requested <Show when={split().fresh.length}><span>{split().fresh.length} new</span></Show></h2>
      <ul class="desk-items"><For each={split().fresh}>{surface => row(surface, true)}</For></ul>
      <Show when={split().earlier.length}>
        <details class="desk-deliverables-earlier" open={split().earlier.some(surface => props.selected === surfaceKey(surface.id))}>
          <summary>Earlier <span class="home-muted">{split().earlier.length}</span></summary>
          <ul class="desk-items"><For each={split().earlier}>{surface => row(surface, false)}</For></ul>
        </details>
      </Show>
      <Show when={props.surfaces.seenError()}>{error => <p class="home-source home-blocked">{error()}</p>}</Show>
    </section>
  </Show>
}

export const SurfaceView = (props: { id: string; surface?: Surface; checked?: number; onOpen?: (surface: Surface) => void; onRetry: () => void; onClose: () => void }) => {
  // Showing a deliverable is what marks it seen, so only a loaded, reachable one counts.
  createEffect(() => { const surface = props.surface; if (surface && !surfaceUnavailable(surface)) props.onOpen?.(surface) })
  const [address, { refetch }] = createResource(() => props.id, surfaceAddress)
  // Reading a failed resource throws; the error is shown from address.error instead.
  const minted = () => address.error ? undefined : address()
  const src = () => minted()?.src
  // Re-mint the frame address before it expires; the frame remounts on the new address.
  createEffect(() => {
    const delay = renewDelay(minted()?.expiresAt, Date.now())
    if (delay === undefined) return
    const timer = setTimeout(() => void refetch(), delay)
    onCleanup(() => clearTimeout(timer))
  })
  const [retries, setRetries] = createSignal(0)
  // Remount the frame on republish, on retry, and when an offline surface comes back.
  const frameKey = () => `${src() ?? ""}|${props.surface?.revision ?? 0}|${props.surface?.health.state}|${retries()}`
  const retry = () => {
    setRetries(retries() + 1)
    props.onRetry()
    if (address.error) void refetch()
  }
  return <section class="desk-evidence desk-surface" aria-label="Surface">
    <div class="desk-evidence-head">
      <h2><bdi dir="auto">{props.surface?.title ?? props.id}</bdi></h2>
      <Show when={props.surface}>{surface => <span class="home-source" title={`${surface().lane ?? "no lane"} · ${surface().editspace} · revision ${surface().revision}`}>
        <bdi dir="auto">{surface().owner}</bdi> · {surfaceProblem(surface().health) ?? `updated ${ago(surface().updated_at)}`}
        <Show when={surface().requested_in}>{asked => <> · <A href={sessionHref(asked().session, asked().directory)} data-requested-in={asked().session}
          title="The conversation this was asked for in">asked in <bdi dir="auto">{asked().title ?? "conversation"}</bdi></A></>}</Show>
      </span>}</Show>
      <span class="desk-surface-actions">
        <Show when={src() && props.surface && !surfaceUnavailable(props.surface)}>
          <a class="desk-button desk-surface-open" href={src()} target="_blank" rel="noopener noreferrer" title="Open in new tab" aria-label="Open in new tab"><Glyph name="link-external" /></a>
        </Show>
        <button class="desk-button" aria-label="Close and return to chat" onClick={props.onClose}>Close</button>
      </span>
    </div>
    <Show when={props.surface} fallback={<p class="desk-surface-state">{props.checked ? "This surface was withdrawn by its owner." : "Loading…"}</p>}>{surface =>
      <Show when={!surfaceUnavailable(surface())} fallback={<div class="desk-surface-state">
        <p><bdi dir="auto">{surface().owner}</bdi> is not serving this surface right now{surface().health.last_ok_at ? `; last seen ${ago(surface().health.last_ok_at!)}` : ""}.</p>
        <button class="desk-button" onClick={retry}>Try again</button>
      </div>}>
        <Show when={!address.error} fallback={<div class="desk-surface-state" role="alert"><p>Cannot open this surface: {String(address.error?.message ?? address.error)}</p><button class="desk-button" onClick={retry}>Try again</button></div>}>
          <Show when={src() ? frameKey() : undefined} keyed fallback={<p class="desk-surface-state" role="status">Opening…</p>}>{_key =>
            <iframe class="desk-surface-frame" title={surface().title} src={src()} referrerpolicy="no-referrer"
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" />}</Show>
        </Show>
      </Show>}
    </Show>
  </section>
}

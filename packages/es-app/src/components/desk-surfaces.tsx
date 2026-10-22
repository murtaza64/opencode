/* Agent-owned surfaces in the Front Desk: a sidebar group above the queue and the selected
 * surface in the main panel. Content runs in the server-sandboxed frame; the desk renders
 * only the title, owner, update time and health that the registry reports. */
import { createResource, createSignal, For, Show } from "solid-js"
import { ago } from "../state"
import { surfaceAddress, surfaceKey, surfaceProblem, surfaceUnavailable, type Surface, type createSurfaces } from "../surfaces"
import { Glyph } from "./icons"
import "./desk-surfaces.css"

export const SurfaceList = (props: { surfaces: ReturnType<typeof createSurfaces>; selected?: string; onSelect: (key: string) => void }) => {
  const list = () => props.surfaces.list()
  const allOffline = () => list().length > 0 && list().every(surfaceUnavailable)
  const rows = () => <ul class="desk-items">
    <For each={list()}>{surface =>
      <li><button class="desk-item desk-surface-row" aria-pressed={props.selected === surfaceKey(surface.id)} data-surface={surface.id}
        data-unavailable={surfaceUnavailable(surface) ? "" : undefined} onClick={() => props.onSelect(surfaceKey(surface.id))}>
        <bdi dir="auto" class="desk-item-title">{surface.title}</bdi>
        <span class="home-source"><bdi dir="auto">{surface.owner}</bdi> · {surfaceProblem(surface.health) ?? `updated ${ago(surface.updated_at)}`}</span>
      </button></li>}</For>
  </ul>
  return <Show when={list().length || props.surfaces.error()}>
    <section class="desk-surfaces" aria-label="Surfaces">
      {/* When nothing can be shown the group folds to one line, still openable. */}
      <Show when={allOffline()} fallback={<><h2>Surfaces</h2>{rows()}</>}>
        <details class="desk-surfaces-offline" open={list().some(surface => props.selected === surfaceKey(surface.id))}>
          <summary>Surfaces <span class="home-muted">· {list().length} offline</span></summary>
          {rows()}
        </details>
      </Show>
      <Show when={props.surfaces.error()}>{error => <p class="home-source home-blocked">{error()}</p>}</Show>
    </section>
  </Show>
}

export const SurfaceView = (props: { id: string; surface?: Surface; checked?: number; onRetry: () => void; onClose: () => void }) => {
  const [src, { refetch }] = createResource(() => props.id, surfaceAddress)
  const [retries, setRetries] = createSignal(0)
  // Remount the frame on republish, on retry, and when an offline surface comes back.
  const frameKey = () => `${src() ?? ""}|${props.surface?.revision ?? 0}|${props.surface?.health.state}|${retries()}`
  const retry = () => {
    setRetries(retries() + 1)
    props.onRetry()
    if (src.error) void refetch()
  }
  return <section class="desk-evidence desk-surface" aria-label="Surface">
    <div class="desk-evidence-head">
      <h2><bdi dir="auto">{props.surface?.title ?? props.id}</bdi></h2>
      <Show when={props.surface}>{surface => <span class="home-source" title={`${surface().lane ?? "no lane"} · ${surface().editspace} · revision ${surface().revision}`}>
        <bdi dir="auto">{surface().owner}</bdi> · {surfaceProblem(surface().health) ?? `updated ${ago(surface().updated_at)}`}
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
        <Show when={!src.error} fallback={<div class="desk-surface-state" role="alert"><p>Cannot open this surface: {String(src.error?.message ?? src.error)}</p><button class="desk-button" onClick={retry}>Try again</button></div>}>
          <Show when={src() ? frameKey() : undefined} keyed>{_key =>
            <iframe class="desk-surface-frame" title={surface().title} src={src()} referrerpolicy="no-referrer"
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" />}</Show>
        </Show>
      </Show>}
    </Show>
  </section>
}

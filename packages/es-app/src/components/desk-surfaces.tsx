/* Agent-owned surfaces in the Front Desk: a sidebar group above the queue and the selected
 * surface in the main panel. Content runs in the server-sandboxed frame; the desk renders
 * only the title, owner, update time and health that the registry reports. */
import { AppHeader } from "./native-header"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { A } from "@solidjs/router"
import { ago, sessionHref } from "../state"
import { isDeliverable, renewDelay, surfaceAddress, surfaceKey, surfaceProblem, surfaceUnavailable, type Surface, type createSurfaces } from "../surfaces"
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
 * New ones lead with a count; ones marked Done fold under Earlier. Opening one never marks it Done. */
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

export type MarkDone = (surface: Surface, revision: number, seen: boolean) => Promise<boolean>

/** A reader's Done/Undo for the deliverable revision on screen; `onDone` writes it to the deliverable's own host. */
export const createDeliverableDone = (surface: () => Surface | undefined, onDone: () => MarkDone | undefined) => {
  // A deliverable keeps the revision it first showed until the human loads a newer one, so Done covers only what
  // was on screen; a board follows every republish.
  const [shown, setShown] = createSignal<number>()
  createEffect(() => { if (surface() && shown() === undefined) setShown(surface()!.revision) })
  const deliverable = () => { const value = surface(); return value && isDeliverable(value) ? value : undefined }
  const onScreen = () => deliverable() ? shown() ?? 0 : surface()?.revision ?? 0
  const newer = () => { const value = deliverable(); return value && value.revision > onScreen() ? value.revision : undefined }
  // Done this reader saved for the revision on screen. The list's seen covers it only while that revision is current,
  // so a Done on N stays visible here after N+1 lands, while N+1 stays new everywhere.
  const [saved, setSaved] = createSignal<{ revision: number; at: number }>()
  const done = () => {
    const value = deliverable()
    if (!value) return undefined
    if (saved()?.revision === onScreen()) return { at: saved()!.at }
    return value.seen && value.revision === onScreen() ? { at: value.seen_at ?? undefined } : undefined
  }
  // A frame serves whatever revision is current when it loads, not the list row read before. Re-reading the list after
  // the load and finding the same revision proves the frame shows it (revisions only grow); otherwise "newer revision"
  // stands and Done waits until that one is loaded. A labelled use on the owning host (`used`) covers the revision on screen.
  const [confirmed, setConfirmed] = createSignal<number>()
  const loaded = async (reread: () => Promise<unknown>) => {
    const revision = onScreen()
    await reread()
    if (surface()?.revision === revision) setConfirmed(revision)
  }
  const used = () => setConfirmed(onScreen())
  const ready = () => confirmed() === onScreen()
  const [writing, setWriting] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const mark = async (seen: boolean) => {
    const value = deliverable()
    const write = onDone()
    if (!value || !write || !ready() || writing()) return
    const revision = onScreen()
    setWriting(true)
    const ok = await write(value, revision, seen)
    setWriting(false)
    setFailed(!ok)
    if (ok) setSaved(seen ? { revision, at: Date.now() } : undefined)
  }
  return { deliverable, onScreen, newer, load: setShown, done, writing, failed, mark, loaded, used, ready, enabled: () => !!deliverable() && !!onDone() }
}

/** The Done/Undo controls of one reader (and "newer revision" when the deliverable was republished while open). */
// Done/Undo appear only once the revision on screen is proven (`ready`); "newer revision" shows whenever one exists.
export const DeliverableDoneControls = (props: { state: ReturnType<typeof createDeliverableDone>; label?: string }) =>
  <Show when={props.state.enabled() && (props.state.ready() || props.state.newer())}>
    <span class="surface-head-done" data-revision={props.state.onScreen()}>
      <Show when={props.state.newer()}>{revision => <button class="surface-head-text" data-newer={revision()} title="Load the newer revision; Done covers only the revision on screen" onClick={() => props.state.load(revision())}>newer revision {revision()}</button>}</Show>
      <Show when={props.state.ready()}>
        <Show when={props.state.done()} fallback={<button class="surface-head-text surface-done" disabled={props.state.writing()} title={`Mark revision ${props.state.onScreen()} done; it leaves Needs you on every device`} onClick={() => void props.state.mark(true)}>{props.label ?? "Done"}</button>}>{state =>
          <><span class="surface-done-state" role="status">Done{state().at ? ` · ${ago(state().at!)}` : ""}</span>
            <button class="surface-head-text" disabled={props.state.writing()} title={`Undo Done for revision ${props.state.onScreen()}`} onClick={() => void props.state.mark(false)}>Undo</button></>}</Show>
      </Show>
      <Show when={props.state.failed()}><span class="home-blocked" role="alert">not saved</span></Show>
    </span>
  </Show>

export const SurfaceView = (props: { id: string; surface?: Surface; checked?: number; onDone?: MarkDone; onLoaded?: () => Promise<unknown>; onRetry: () => void; onClose: () => void }) => {
  // Done covers what the human saw, so it waits for the frame: never while loading, offline or failed.
  const doneState = createDeliverableDone(() => props.surface, () => src() && !address.error && props.surface && !surfaceUnavailable(props.surface) ? props.onDone : undefined)
  const onScreen = doneState.onScreen
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
  // Remount the frame on a board's republish, on loading a deliverable's newer revision, on retry, and when an
  // offline surface comes back.
  const frameKey = () => `${src() ?? ""}|${onScreen()}|${props.surface?.health.state}|${retries()}`
  const retry = () => {
    setRetries(retries() + 1)
    props.onRetry()
    if (address.error) void refetch()
  }
  // One compact bar: title (owner, revision and freshness in its tooltip), "asked in", open in a new tab, close. The
  // frame takes the rest of the pane edge to edge. Escape anywhere in the pane outside the frame closes it.
  const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); props.onClose() } }
  return <section class="desk-evidence desk-surface" aria-label="Surface" onKeyDown={closeOnEscape}>
    {/* The app's one top bar (the Mac window's title bar in the desktop app): title, "asked in", a reserved
      * BuildingHub slot, open in a new tab, close. Escape there closes too, since the bar sits outside this section. */}
    <AppHeader>
      <div class="surface-head" onKeyDown={closeOnEscape}>
        <h2 title={props.surface ? `${props.surface.owner} · ${surfaceProblem(props.surface.health) ?? `updated ${ago(props.surface.updated_at)}`} · ${props.surface.lane ?? "no lane"} · ${props.surface.editspace} · revision ${props.surface.revision}` : undefined}>
          <bdi dir="auto">{props.surface?.title ?? props.id}</bdi></h2>
        <Show when={props.surface?.requested_in}>{asked => <A class="surface-head-link" href={sessionHref(asked().session, asked().directory)} data-requested-in={asked().session}
          title="The conversation this was asked for in">asked in <bdi dir="auto">{asked().title ?? "conversation"}</bdi></A>}</Show>
        <DeliverableDoneControls state={doneState} />
        <span class="surface-head-actions">
          {/* Reserved for "BuildingHub version" (Laptop2649): shown only from a deployed receipt, which no API offers yet. */}
          <span class="surface-head-slot" data-slot="buildinghub" hidden />
          <Show when={src() && props.surface && !surfaceUnavailable(props.surface)}>
            <a class="surface-head-button" href={src()} target="_blank" rel="noopener noreferrer" title="Open in new tab" aria-label="Open in new tab"><Glyph name="link-external" /></a>
          </Show>
          <button class="surface-head-button" aria-label="Close and return to chat" title="Close (Esc)" onClick={props.onClose}>×</button>
        </span>
      </div>
    </AppHeader>
    <Show when={props.surface} fallback={<p class="desk-surface-state">{props.checked ? "This surface was withdrawn by its owner." : "Loading…"}</p>}>{surface =>
      <Show when={!surfaceUnavailable(surface())} fallback={<div class="desk-surface-state">
        <p><bdi dir="auto">{surface().owner}</bdi> is not serving this surface right now{surface().health.last_ok_at ? `; last seen ${ago(surface().health.last_ok_at!)}` : ""}.</p>
        <button class="desk-button" onClick={retry}>Try again</button>
      </div>}>
        <Show when={!address.error} fallback={<div class="desk-surface-state" role="alert"><p>Cannot open this surface: {String(address.error?.message ?? address.error)}</p><button class="desk-button" onClick={retry}>Try again</button></div>}>
          <Show when={src() ? frameKey() : undefined} keyed fallback={<p class="desk-surface-state" role="status">Opening…</p>}>{_key =>
            <iframe class="desk-surface-frame" title={surface().title} src={src()} referrerpolicy="no-referrer" onLoad={() => void doneState.loaded(() => props.onLoaded?.() ?? Promise.resolve())}
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" />}</Show>
        </Show>
      </Show>}
    </Show>
  </section>
}

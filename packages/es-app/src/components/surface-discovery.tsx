/* The slim bar under a chat's top bar: the latest Surface its agent published. Open keeps it; × dismisses that
 * Surface's current revision for this chat on this device. A newer revision, or a newer Surface, brings it back
 * with "updated". The header menu and +N list the same author's Surfaces; dismissal never marks one seen or read. */
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { A } from "@solidjs/router"
import { clockTime } from "../local-time"
import type { Surface } from "../surfaces"
import { SurfaceGlyph } from "./surface-glyph"

type Dismissed = Record<string, { revision: number; at: number }>
const read = (key: string): Dismissed => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export const SurfaceDiscovery = (props: { sessionID: string; editspace: string; host?: string; surfaces: Surface[]; href: (surface: Surface) => string }) => {
  const key = createMemo(() => `es-app:surface-dismissed:${props.host ?? "local"}:${props.editspace}:${props.sessionID}`)
  const [dismissed, setDismissed] = createSignal<Dismissed>(read(key()))
  // The project name can arrive after the chat mounts; re-read when the key becomes real.
  createEffect(on(key, (value) => setDismissed(read(value)), { defer: true }))
  const sorted = createMemo(() => [...props.surfaces].sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0) || b.revision - a.revision))
  const latest = () => sorted()[0]
  const dismissal = () => { const item = latest(); return item ? dismissed()[item.id] : undefined }
  const shown = () => !!latest() && dismissal()?.revision !== latest().revision
  const updated = () => {
    const item = latest()
    const all = dismissed()
    if (!item || !Object.keys(all).length) return false
    return !all[item.id] || all[item.id].revision !== item.revision
  }
  const dismiss = () => {
    const item = latest()
    if (!item) return
    const next = { ...dismissed(), [item.id]: { revision: item.revision, at: Date.now() } }
    setDismissed(next)
    try { localStorage.setItem(key(), JSON.stringify(next)) } catch { /* kept for this page */ }
  }
  const more = () => sorted().slice(1)
  const label = (surface: Surface) => `${surface.title} · r${surface.revision}`
  return <Show when={latest()}>
    {surface => <Show when={shown()}>
      <section class="surface-discovery" aria-label="Latest Surface">
        <SurfaceGlyph surface={surface()} />
        <span class="surface-discovery-title" dir="auto" title={label(surface())}>{surface().title}</span>
        <span class="surface-discovery-meta">r{surface().revision} · {clockTime(surface().updated_at || surface().created_at || Date.now())}</span>
        <Show when={updated()}><span class="surface-discovery-updated">updated</span></Show>
        <Show when={more().length}>
          <details class="surface-discovery-all">
            <summary aria-label={`${more().length} more Surfaces from this agent`}>+{more().length}</summary>
            <div class="surface-discovery-list" role="group" aria-label="Surfaces from this agent">
              <For each={more()}>{item => <A href={props.href(item)} title={label(item)}><SurfaceGlyph surface={item} /><bdi dir="auto">{label(item)}</bdi></A>}</For>
            </div>
          </details>
        </Show>
        <A class="surface-discovery-open" href={props.href(surface())} aria-label={`Open ${label(surface())}`}>Open</A>
        <button type="button" class="surface-discovery-dismiss" aria-label={`Dismiss ${label(surface())}`} title="Dismiss this revision" onClick={dismiss}>×</button>
      </section>
    </Show>}
  </Show>
}

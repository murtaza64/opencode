import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { changeNotes, intentLabel, markOpened, openedRevision } from "../surface-notes"
import { declareLooks, lookNote, lookStates, requestLook } from "../surface-look"
import type { Surface } from "../surfaces"

/**
 * The reader's change line (DD #725/#753): for the revision on screen, "Since rN · <intent>", the author's note, the
 * places to look (buttons that scroll and highlight only when clicked) and the response it asks for. When this device
 * last opened an older revision than the note's base, it says so and offers the earlier notes, so the latest note never
 * reads as covering every missed change. Opening records the revision for next time. All author text is plain text.
 */
export const SurfaceChangeNote = (props: { surface: Surface; host?: string; revision: number }) => {
  // The comparison base is what this device had opened before this reader showed the Surface.
  const [base] = createSignal(openedRevision(props.host ?? "", props.surface.id))
  onMount(() => markOpened(props.host ?? "", props.surface.id, props.revision))
  const live = () => props.revision === props.surface.revision
  // The record of the revision on screen (a deliverable keeps its first revision until the human loads a newer one).
  const record = () => live() ? undefined : props.surface.notes?.find(note => note.revision === props.revision)
  const change = () => live() ? props.surface.change : record() && {
    base: record()!.base ?? (props.revision > 1 ? props.revision - 1 : null), intent: record()!.intent ?? null, look: record()!.look ?? [], respond: record()!.respond ?? null }
  const shown = () => ({ revision: props.revision, notes: props.surface.notes, change: change(),
    whats_new: live() ? props.surface.whats_new : record()?.text ?? null })
  const notes = () => changeNotes(shown(), base())
  const looks = () => change()?.look ?? []
  createEffect(() => declareLooks(props.surface.id, looks()))
  const states = () => lookStates(props.surface.id)
  const [open, setOpen] = createSignal(false)
  // One fixed row (the frame top never moves between revisions or note/no note); More expands it in place.
  const [expanded, setExpanded] = createSignal(false)
  const [overflows, setOverflows] = createSignal(false)
  let row: HTMLDivElement | undefined
  const measure = () => { if (row && !expanded()) setOverflows(row.scrollWidth > row.clientWidth + 1) }
  onMount(() => {
    const observer = new ResizeObserver(measure)
    if (row) observer.observe(row)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => { notes(); looks(); change(); queueMicrotask(measure) })
  const lead = () => [change()?.base ? `Since r${change()!.base}` : undefined, intentLabel(change()?.intent)].filter(Boolean).join(" · ")
  return <Show when={notes().current || notes().since || lead() || looks().length || change()?.respond}>
    <div class="surface-change-wrap" data-expanded={expanded() ? "" : undefined}>
    <div ref={row} class="surface-change" data-surface-change={props.revision} data-intent={change()?.intent ?? undefined}>
      <span class="surface-change-label">{lead() || `What's new in rev ${props.revision}`}</span>
      <span class="surface-change-text" classList={{ "surface-change-none": !shown().whats_new }} dir="auto">{notes().current ?? "No change note provided"}</span>
      <Show when={looks().length}>
        <span class="surface-change-look">Look at:
          <For each={looks()}>{(place, index) => {
            const note = () => lookNote(states()?.[index()], props.revision)
            return <button type="button" class="link-button surface-change-place" data-look={index()} aria-describedby={note() ? `look-note-${index()}` : undefined}
              onClick={() => requestLook(props.surface.id, index())}><bdi dir="auto">{place.label}</bdi> →<Show when={note()}>{text => <span class="surface-change-none" id={`look-note-${index()}`}> ({text()})</span>}</Show></button>
          }}</For>
        </span>
      </Show>
      <Show when={change()?.respond}>{question => <span class="surface-change-respond">Respond: <bdi dir="auto">{question()}</bdi></span>}</Show>
      <Show when={notes().since}>{since => <>
        <button type="button" class="link-button surface-change-since" aria-expanded={open()} onClick={() => { const next = !open(); setOpen(next); if (next) setExpanded(true) }}>
          you last opened r{since().base}{since().earlier.length ? ` · ${since().earlier.length} earlier note${since().earlier.length > 1 ? "s" : ""}` : ""}
        </button>
        <Show when={open()}>
          <ul class="surface-change-earlier">
            <For each={since().earlier}>{note => <li><span class="surface-change-label">rev {note.revision}</span> <span dir="auto">{note.text}</span></li>}</For>
            <Show when={since().unnoted}><li class="surface-change-none">{since().unnoted} revision{since().unnoted > 1 ? "s" : ""} with no change note</li></Show>
          </ul>
        </Show>
      </>}</Show>
    </div>
    <Show when={overflows() || expanded()}>
      <button type="button" class="link-button surface-change-more" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>{expanded() ? "Less" : "More"}</button>
    </Show>
    </div>
  </Show>
}

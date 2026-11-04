import { createSignal, For, onMount, Show } from "solid-js"
import { changeNotes, markOpened, openedRevision } from "../surface-notes"
import type { Surface } from "../surfaces"

/**
 * The reader's "What's new" line (DD #725): the author's note for the revision on screen. When this device last opened
 * an older revision and revisions were missed, it says so ("since rev N you last opened") and offers the earlier notes,
 * so the latest note never reads as covering every missed change. Opening records the revision for next time.
 */
export const SurfaceChangeNote = (props: { surface: Surface; host?: string; revision: number }) => {
  // The comparison base is what this device had opened before this reader showed the Surface.
  const [base] = createSignal(openedRevision(props.host ?? "", props.surface.id))
  onMount(() => markOpened(props.host ?? "", props.surface.id, props.revision))
  // The note of the revision on screen (a deliverable keeps its first revision until the human loads a newer one).
  const shown = () => ({ revision: props.revision, notes: props.surface.notes,
    whats_new: props.revision === props.surface.revision ? props.surface.whats_new : props.surface.notes?.find(note => note.revision === props.revision)?.text ?? null })
  const notes = () => changeNotes(shown(), base())
  const [open, setOpen] = createSignal(false)
  return <Show when={notes().current || notes().since}>
    <div class="surface-change" data-surface-change={props.revision}>
      <span class="surface-change-label">What's new in rev {props.revision}</span>
      <span class="surface-change-text" classList={{ "surface-change-none": !shown().whats_new }} dir="auto">{notes().current ?? "No change note provided"}</span>
      <Show when={notes().since}>{since => <>
        <button type="button" class="link-button surface-change-since" aria-expanded={open()} onClick={() => setOpen(!open())}>
          since rev {since().base} you last opened{since().earlier.length ? ` · ${since().earlier.length} earlier note${since().earlier.length > 1 ? "s" : ""}` : ""}
        </button>
        <Show when={open()}>
          <ul class="surface-change-earlier">
            <For each={since().earlier}>{note => <li><span class="surface-change-label">rev {note.revision}</span> <span dir="auto">{note.text}</span></li>}</For>
            <Show when={since().unnoted}><li class="surface-change-none">{since().unnoted} revision{since().unnoted > 1 ? "s" : ""} with no change note</li></Show>
          </ul>
        </Show>
      </>}</Show>
    </div>
  </Show>
}

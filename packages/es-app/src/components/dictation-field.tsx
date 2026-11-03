import { For, onCleanup, onMount, Show } from "solid-js"
import { dictation, fieldTarget, type Dictation } from "../dictation"
import { Glyph } from "./icons"

const MIC =
  "M8 1a2.75 2.75 0 0 0-2.75 2.75v4a2.75 2.75 0 0 0 5.5 0v-4A2.75 2.75 0 0 0 8 1Zm-1.25 2.75a1.25 1.25 0 0 1 2.5 0v4a1.25 1.25 0 0 1-2.5 0Zm-3 3.5a.75.75 0 0 1 .75.75 3.5 3.5 0 0 0 7 0 .75.75 0 0 1 1.5 0 5 5 0 0 1-4.25 4.944V14.5h1.75a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5h1.75v-1.556A5 5 0 0 1 3 8a.75.75 0 0 1 .75-.75Z"

/** Dictation into a non-composer field (a decision card's note, DD #333): tap to record, tap to transcribe into the
 * field at its caret. Never submits. Renders nothing without the native voice bridge. */
export const DictationField = (props: { field: string; label: string; insert: (text: string) => void; dictation?: Dictation }) => {
  const voice = props.dictation ?? dictation
  const state = voice.state
  const target = () => fieldTarget(props.field)
  const mine = () => voice.owns(state.target, target())
  const phase = () => (mine() ? state.phase : "idle")
  onMount(() => {
    if (state.availability === "unknown") void voice.refresh()
    const detach = voice.attachField(props.field, props.insert)
    onCleanup(detach)
  })
  return <Show when={state.availability === "ready" || state.availability === "setup"}>
    <span class="dictation dictation-field" role="group" aria-label={`Dictate ${props.label}`}>
      <button type="button" class="dictation-toggle" disabled={state.availability !== "ready" || (state.phase !== "idle" && !mine()) || phase() === "starting" || phase() === "transcribing"}
        aria-label={phase() === "recording" ? "Stop dictation and transcribe" : phase() === "idle" ? `Dictate ${props.label}` : "Transcribing dictation"}
        title={state.availability === "setup" ? `Dictation unavailable: ${state.setup}` : phase() === "recording" ? "Stop and transcribe" : `Dictate ${props.label}`}
        onClick={() => void voice.toggle(target())}>
        <Show when={phase() === "recording"} fallback={<svg class="glyph" width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d={MIC} /></svg>}>
          <Glyph name="square-fill" />
        </Show>
      </button>
      <span class="dictation-status" aria-live="polite">{phase() === "recording" ? "Recording" : phase() === "transcribing" ? "Transcribing" : ""}</span>
      <For each={voice.pending(target())}>{(item) => <span class="dictation-held">
        <span class="dictation-held-text" dir="auto" title={item.text}>Dictated: {item.text}</span>
        <button type="button" class="dictation-action" onClick={() => voice.acceptPending(target(), item.id)}>Insert</button>
        <button type="button" class="dictation-cancel" aria-label="Discard dictated text" onClick={() => voice.discardPending(target(), item.id)}>×</button>
      </span>}</For>
    </span>
  </Show>
}

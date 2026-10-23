import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { dictationInsert, type Composer } from "../composer"
import { dictation, dictationTarget, type Dictation } from "../dictation"
import { Glyph } from "./icons"

type Props = {
  composer: Composer
  sessionID: string
  directory: string
  // The visible draft editor; read when dictation starts and when text lands.
  editor: () => HTMLTextAreaElement | undefined
  // Vim normal mode shows the caret as a one-character selection.
  normalMode: () => boolean
  // Records the pre-dictation text as one Vim undo step, then re-syncs the Vim cursor after it.
  checkpoint: (el: HTMLTextAreaElement) => void
  refresh: (el: HTMLTextAreaElement) => void
  dictation?: Dictation
}

const MIC =
  "M8 1a2.75 2.75 0 0 0-2.75 2.75v4a2.75 2.75 0 0 0 5.5 0v-4A2.75 2.75 0 0 0 8 1Zm-1.25 2.75a1.25 1.25 0 0 1 2.5 0v4a1.25 1.25 0 0 1-2.5 0Zm-3 3.5a.75.75 0 0 1 .75.75 3.5 3.5 0 0 0 7 0 .75.75 0 0 1 1.5 0 5 5 0 0 1-4.25 4.944V14.5h1.75a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5h1.75v-1.556A5 5 0 0 1 3 8a.75.75 0 0 1 .75-.75Z"
const SHORTCUT = (event: KeyboardEvent) =>
  !event.isComposing && !event.altKey && event.shiftKey && event.metaKey !== event.ctrlKey && event.code === "Space"

/**
 * Record → stop → transcribe into this composer's draft. Renders nothing without the native
 * bridge; disabled with its setup reason when the local pipeline is missing.
 */
export const DictationButton = (props: Props) => {
  const voice = props.dictation ?? dictation
  const state = voice.state
  const draft = { sessionID: props.sessionID, directory: props.directory }
  const mine = () => voice.owns(state.target, draft)
  const elsewhere = () => state.phase !== "idle" && !mine()
  const phase = () => (mine() ? state.phase : "idle")
  const [now, setNow] = createSignal(Date.now())
  // Where text goes: the editor's caret/selection, with a Vim block collapsed to the caret.
  const range = (el: HTMLTextAreaElement): [number, number] =>
    props.normalMode() ? [el.selectionStart, el.selectionStart] : [el.selectionStart, el.selectionEnd]
  const target = () => {
    const buffer = props.composer.state.visibleBuffer
    const el = props.editor()
    const current = props.composer.state[buffer]
    return dictationTarget(props.sessionID, props.directory, buffer, el?.isConnected ? { revision: current.revision, selection: range(el) } : current)
  }
  const toggle = () => {
    if (elsewhere() || state.availability !== "ready") return
    void voice.toggle(target())
  }
  let root: HTMLSpanElement | undefined
  onMount(() => {
    if (state.availability === "unknown") void voice.refresh()
    // The pipeline may be installed while the app is open.
    const focus = () => {
      if (state.availability === "setup") void voice.refresh()
    }
    window.addEventListener("focus", focus)
    const timer = window.setInterval(() => {
      if (state.phase === "recording") setNow(Date.now())
    }, 250)
    const keydown = (event: KeyboardEvent) => {
      const inView = !!root?.closest(".session-page")?.contains(document.activeElement)
      // Esc first cancels this composer's dictation, before Vim or the float editor see it.
      if (event.key === "Escape" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (phase() === "idle" || (!inView && document.activeElement !== document.body)) return
        event.preventDefault()
        event.stopImmediatePropagation()
        void voice.cancel()
        return
      }
      // Mod+Shift+Space while focus is in this session view; never a global hotkey.
      if (!SHORTCUT(event) || !inView) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.repeat) toggle()
    }
    window.addEventListener("keydown", keydown, true)
    // A focused editor takes the text as a native edit, so Cmd+Z and Vim `u` remove it in one step.
    const detach = voice.attach(draft, (landed, text) => {
      const el = props.editor()
      if (!el?.isConnected || document.activeElement !== el || props.composer.state.visibleBuffer !== landed.buffer) return false
      const current = props.composer.state[landed.buffer]
      const next = dictationInsert({ text: el.value, revision: current.revision, selection: range(el) }, landed, text)
      props.checkpoint(el)
      el.setSelectionRange(next.start, next.end)
      if (!document.execCommand("insertText", false, next.inserted)) return false
      el.setSelectionRange(next.caret, next.caret)
      props.composer.setVisibleSelection(next.caret, next.caret)
      props.refresh(el)
      return true
    })
    onCleanup(() => {
      window.removeEventListener("focus", focus)
      window.removeEventListener("keydown", keydown, true)
      window.clearInterval(timer)
      detach()
    })
  })
  // Keep the editor's focus and selection when the button is pressed.
  const keepFocus = (event: PointerEvent) => {
    if (document.activeElement === props.editor()) event.preventDefault()
  }
  const elapsed = () => {
    const seconds = Math.max(0, Math.floor((now() - state.startedAt) / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }
  return (
    <Show when={state.availability === "ready" || state.availability === "setup"}>
      <span class="dictation" ref={root} role="group" aria-label="Dictation" data-phase={phase()}>
        <button
          class="dictation-toggle"
          aria-label={phase() === "recording" ? "Stop dictation and transcribe" : phase() === "idle" ? "Dictate" : "Transcribing dictation"}
          aria-keyshortcuts="Meta+Shift+Space Control+Shift+Space"
          title={
            state.availability === "setup"
              ? `Dictation unavailable: ${state.setup}`
              : elsewhere()
                ? "Dictating in another conversation"
                : phase() === "recording"
                  ? "Stop and transcribe (⌘⇧Space) · Esc cancels"
                  : "Dictate (⌘⇧Space)"
          }
          disabled={state.availability !== "ready" || elsewhere() || phase() === "starting" || phase() === "transcribing"}
          onPointerDown={keepFocus}
          onClick={toggle}
        >
          <Show when={phase() === "recording"} fallback={
            <Show when={phase() === "idle"} fallback={<span class="dictation-spinner" aria-hidden="true" />}>
              <svg class="glyph" width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d={MIC} /></svg>
            </Show>
          }>
            <Glyph name="square-fill" />
          </Show>
        </button>
        {/* One reserved slot, so the bar does not shift between idle, 0:07 and Transcribing. */}
        <span class="dictation-status" aria-live="polite">
          {phase() === "recording" ? elapsed() : phase() === "transcribing" ? "Transcribing…" : phase() === "starting" ? "Starting…" : ""}
        </span>
        <button
          class="dictation-cancel"
          classList={{ idle: phase() === "idle" }}
          aria-label="Cancel dictation"
          title="Cancel (Esc); the draft is unchanged"
          aria-hidden={phase() === "idle"}
          tabIndex={phase() === "idle" ? -1 : 0}
          disabled={phase() === "idle"}
          onPointerDown={keepFocus}
          onClick={() => void voice.cancel()}
        >
          ×
        </button>
      </span>
    </Show>
  )
}

/** The failure line for dictation that targeted this composer; cleared by the next attempt. */
export const DictationFeedback = (props: Pick<Props, "sessionID" | "directory" | "dictation">) => {
  const voice = props.dictation ?? dictation
  const error = () => {
    const value = voice.state.error
    return value && voice.owns(value.target, props) ? value : undefined
  }
  return (
    <Show when={error()}>
      {(value) => (
        <div class="direct-feedback dictation-feedback" role="alert">
          <span class="dictation-error">{value().message}</span>
          <Show when={value().detail}>
            <details class="dictation-details">
              <summary>Details</summary>
              <pre dir="auto">{value().detail}</pre>
            </details>
          </Show>
          <Show when={value().action === "retry"}>
            {/* The original target: if the draft changed since, text goes in at the current caret. */}
            <button onClick={() => void voice.start(value().target)}>Try again</button>
          </Show>
          <Show when={value().action === "settings"}>
            <button onClick={() => void voice.settings()}>Open settings</button>
          </Show>
          <button aria-label="Dismiss dictation error" onClick={() => voice.dismiss()}>Dismiss</button>
        </div>
      )}
    </Show>
  )
}

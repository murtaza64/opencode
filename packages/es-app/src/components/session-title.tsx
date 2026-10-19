import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2"
import { oc } from "../api"
import { errorText } from "../live-session"
import "./session-title.css"

export const SessionTitle = (props: {
  sessionID: string
  directory: string
  session: Session | undefined
  onSaved: (session: Session) => void
}) => {
  const [state, setState] = createStore({ editing: false, draft: "", saving: false, error: "" })
  let disposed = false
  let blur: ReturnType<typeof setTimeout> | undefined
  let button: HTMLButtonElement | undefined
  const previousTitle = document.title
  createEffect(() => { document.title = props.session?.title ?? props.sessionID })
  onCleanup(() => {
    disposed = true
    clearTimeout(blur)
    document.title = previousTitle
  })
  const close = (focus = false) => {
    clearTimeout(blur)
    setState({ editing: false, error: "" })
    if (focus) button?.focus()
  }
  const save = async (focus = false) => {
    clearTimeout(blur)
    if (disposed || !state.editing || state.saving) return
    const title = state.draft.trim()
    if (!title || title === props.session?.title) return close(focus)
    setState({ saving: true, error: "" })
    try {
      const session = await oc.rename(props.sessionID, props.directory, title)
      if (disposed) return
      props.onSaved(session)
      close(focus)
    } catch (error) {
      if (!disposed) setState("error", `Could not rename session: ${errorText(error)}`)
    } finally {
      if (!disposed) setState("saving", false)
    }
  }
  return (
    <div class="session-title">
      <Show when={state.editing} fallback={
        <h1><button ref={button} type="button" class="session-title-button" dir="auto"
          aria-label="Rename session" title={props.session?.title ?? props.sessionID} disabled={!props.session}
          onClick={() => setState({ editing: true, draft: props.session?.title ?? "", error: "" })}>
          {props.session?.title ?? props.sessionID}
        </button></h1>
      }>
        <form class="session-title-form" aria-label="Rename session" onSubmit={(event) => {
          event.preventDefault()
          void save(true)
        }}>
          <input aria-label="Session title" dir="auto" value={state.draft} readOnly={state.saving}
            aria-invalid={!!state.error} aria-describedby={state.error ? "session-title-error" : undefined}
            ref={(input) => queueMicrotask(() => {
              if (disposed || !input.isConnected) return
              input.focus()
              input.select()
            })}
            onInput={(event) => setState("draft", event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Escape") {
                event.preventDefault()
                if (!state.saving) close(true)
              }
              if (event.key === "Enter" && event.isComposing) event.preventDefault()
            }}
            onBlur={() => {
              // Let route navigation dispose the keyed session before blur saves.
              blur = setTimeout(() => { if (!state.error) void save() }, 0)
            }} />
          <Show when={state.saving}><span role="status">Saving…</span></Show>
          <Show when={state.error}>
            <span class="session-title-error err" id="session-title-error" role="alert">{state.error}</span>
            <button type="submit" disabled={state.saving}>Retry</button>
          </Show>
        </form>
      </Show>
    </div>
  )
}

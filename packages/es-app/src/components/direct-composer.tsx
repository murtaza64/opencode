import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import type { Composer, ComposerAction } from "../composer"
import { ComposerImages } from "./composer-images"
import "./direct-composer.css"

// One primary action (Send when idle, Steer while busy); Queue and Aside sit in
// a secondary menu because they are rarely used. Cmd+M still cycles the
// keyboard target, and the primary button always shows that target.
export const DirectComposer = (props: {
  composer: Composer
  connected: boolean
  submit: (action: ComposerAction) => void
  restoreDraft: () => void
  editor: JSX.Element
  attachments: JSX.Element
  sessionActions: JSX.Element
  sessionMetadata?: JSX.Element
  dictation?: JSX.Element
  dictationFeedback?: JSX.Element
  children: JSX.Element
}) => {
  const state = props.composer.state
  const actions = ["steer", "queue", "aside"] as const
  const [menu, setMenu] = createSignal(false)
  createEffect(on(() => state.busy, () => setMenu(false), { defer: true }))
  const primary = () => (state.busy ? state.keyboardTarget : "steer")
  const secondary = () => (state.busy ? actions.filter((action) => action !== primary()) : [])
  const nextTarget = () => actions[(actions.indexOf(state.keyboardTarget) + 1) % actions.length]
  const label = (action: ComposerAction) => (state.busy ? action[0]!.toUpperCase() + action.slice(1) : "Send")
  const hint = (action: ComposerAction) =>
    action === "queue" ? "After this task" : action === "aside" ? "Side question" : "At the next safe point"
  const reason = (action: ComposerAction) =>
    !props.connected
      ? "Session unavailable or another session action is running."
      : props.composer.reasonForAction(action)
  const empty = () => !props.composer.visibleDraft().text.trim() && !props.composer.visibleDraft().images.length
  const reasons = () =>
    props.connected ? [...new Set([primary(), ...(menu() ? secondary() : [])].map(reason).filter(Boolean))] : []
  const other = () => state[state.visibleBuffer === "task" ? "aside" : "task"]
  // Keep textarea focus (and its selection) when a submit button is pressed.
  const keepFocus = (e: PointerEvent) => {
    const focused = document.activeElement
    if (focused instanceof HTMLTextAreaElement && (e.currentTarget as Element).closest(".direct-composer")?.contains(focused))
      e.preventDefault()
  }
  let menuRoot: HTMLDivElement | undefined
  const dismiss = (e: Event) => {
    if (menu() && !(e.target instanceof Node && menuRoot?.contains(e.target))) setMenu(false)
  }
  // Focus usually stays in the textarea while the menu is open, so Escape is
  // caught at the document and closes the menu before vim or the float see it.
  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !menu()) return
    e.preventDefault()
    e.stopPropagation()
    setMenu(false)
  }
  document.addEventListener("pointerdown", dismiss, true)
  document.addEventListener("keydown", escape, true)
  onCleanup(() => {
    document.removeEventListener("pointerdown", dismiss, true)
    document.removeEventListener("keydown", escape, true)
  })
  const SubmitButton = (p: { action: ComposerAction; class: string }) => (
    <button
      class={p.class}
      data-keyboard-target={primary() === p.action}
      aria-label={label(p.action)}
      aria-keyshortcuts={primary() === p.action ? "Meta+Enter Control+Enter" : undefined}
      title={reason(p.action) || (state.busy ? hint(p.action) : undefined)}
      disabled={!!reason(p.action) || empty()}
      onPointerDown={keepFocus}
      onClick={() => {
        setMenu(false)
        props.submit(p.action)
      }}
    >
      <span>{label(p.action)}</span>
      <Show when={p.class === "direct-more-action"}>
        <span class="direct-action-hint">{hint(p.action)}</span>
      </Show>
      <kbd class="direct-button-hint" aria-hidden="true">
        {primary() === p.action ? "⌘↵" : nextTarget() === p.action ? "⌘M" : ""}
      </kbd>
    </button>
  )
  // Editing a pending input replaces the writing area in place. The ordinary
  // draft stays mounted but hidden, so its text, images and selection are untouched.
  const editing = () => props.composer.editingInput()
  return (
    <div class="direct-composer" classList={{ editing: !!editing() }} data-composer-controls>
      <div class="direct-draft" hidden={!!editing()}>
        {props.attachments}
        {props.editor}
        <Show when={other().text || other().images.length}>
          <button class="direct-recover" onClick={props.restoreDraft}>
            Restore saved {state.visibleBuffer === "task" ? "Aside" : "task"} draft
          </button>
        </Show>
      </div>
      <Show when={editing()}>{(id) => <PendingEdit composer={props.composer} connected={props.connected} id={id()} />}</Show>
      <div class="direct-bar">
        <div class="direct-session-actions" role="group" aria-label="Session actions">
          {props.sessionActions}
        </div>
        <div class="direct-send" role="group" aria-label="Send" hidden={!!editing()}>
          {props.dictation}
          <span class="direct-session-metadata">{props.sessionMetadata}</span>
          <div class="direct-model" role="group" aria-label="Model">
            {props.children}
          </div>
          <div class="direct-split" ref={menuRoot}>
            <SubmitButton action={primary()} class="direct-primary" />
            {/* Always laid out so the primary button does not move when the session turns busy. */}
            <button
              class="direct-more"
              classList={{ idle: !state.busy }}
              aria-label="More send options"
              aria-expanded={menu()}
              aria-haspopup="true"
              aria-hidden={!state.busy}
              tabIndex={state.busy ? 0 : -1}
              disabled={!state.busy}
              onPointerDown={keepFocus}
              onClick={() => setMenu(!menu())}
            >
              ▾
            </button>
            <Show when={menu() && state.busy}>
              <div class="direct-more-menu" role="group" aria-label="More send options">
                <For each={secondary()}>{(action) => <SubmitButton action={action} class="direct-more-action" />}</For>
              </div>
            </Show>
          </div>
        </div>
      </div>
      <Show when={reasons().length && !state.superseded}>
        <div class="direct-feedback dim">
          <For each={reasons()}>{(value) => <div>{value}</div>}</For>
        </div>
      </Show>
      {props.dictationFeedback}
      <Show when={state.storageError}>
        <div class="direct-feedback err" role="alert">
          {state.storageError}
          <button onClick={() => props.composer.setImages([], state.visibleBuffer)}>Clear saved images</button>
        </div>
      </Show>
      <Show when={state.error && !state.superseded}>
        <div class="direct-feedback err" role="alert">
          {state.error}
        </div>
      </Show>
      <Show when={props.connected && (!state.capabilities || state.capabilityError)}>
        <button
          class="direct-feedback"
          disabled={!props.connected}
          onClick={async () => {
            await props.composer.loadCapabilities()
            await props.composer.refreshInputs()
          }}
        >
          Refresh availability
        </button>
      </Show>
    </div>
  )
}

const PendingEdit = (props: { composer: Composer; connected: boolean; id: string }) => {
  const state = props.composer.state
  const edit = () => state.inputEdits[props.id]!
  const current = () => state.receipts.find((item) => item.requestID === props.id)
  const locked = () => edit().status === "saving" || edit().status === "unknown"
  const save = () => {
    if (props.connected && edit().status !== "saving" && edit().status !== "conflict") void props.composer.saveInput(props.id)
  }
  const close = () => {
    if (edit().status !== "saving") props.composer.closeInputEdit(props.id)
  }
  return (
    <section class="direct-edit" aria-label="Edit pending input" data-edit-request-id={props.id}>
      <div class="direct-edit-head">
        <b>Editing pending message</b>
        <select aria-label="Pending input delivery" value={edit().delivery} disabled={locked()}
          onChange={(event) => props.composer.changeInputEdit(props.id, { delivery: event.currentTarget.value === "queue" ? "queue" : "steer" })}>
          <option value="steer">Steer</option>
          <option value="queue">Queue</option>
        </select>
        <Show when={edit().status === "saving"}><span class="dim" role="status">Saving…</span></Show>
      </div>
      <Show when={edit().status === "conflict" && current()}>
        {(receipt) => <p class="direct-edit-current" dir="auto">Now {receipt().state}: {receipt().text}</p>}
      </Show>
      <div class="ta-wrap">
        <textarea dir="auto" aria-label="Pending input text" value={edit().text} disabled={locked()}
          ref={(el) => queueMicrotask(() => { if (!el.disabled) el.focus() })}
          onInput={(event) => props.composer.changeInputEdit(props.id, { text: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.isComposing) return
            // Keep composer shortcuts (send, Cmd+M target cycling) away from an edit.
            if ((event.metaKey || event.ctrlKey) && event.code === "KeyM") event.preventDefault()
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              save()
            }
            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }} />
      </div>
      <ComposerImages images={current()?.images} />
      <Show when={edit().error}><p class="err" role="alert">{edit().error}</p></Show>
      <div class="direct-edit-actions">
        <Show when={edit().status === "conflict" && current()?.state === "pending"}>
          <button onClick={() => props.composer.rebaseInputEdit(props.id)}>Keep edit against current revision</button>
        </Show>
        <button aria-label="Cancel edit" disabled={edit().status === "saving"} onClick={close}>Cancel</button>
        <button class="direct-primary" aria-label={edit().status === "unknown" ? "Retry same update" : "Save pending input"}
          disabled={!props.connected || edit().status === "saving" || edit().status === "conflict"} onClick={save}>
          <span>{edit().status === "unknown" ? "Retry update" : "Save"}</span>
          <kbd class="direct-button-hint" aria-hidden="true">⌘↵</kbd>
        </button>
      </div>
    </section>
  )
}

import { For, Show } from "solid-js"
import type { Composer, ComposerMode } from "../composer"

export const ComposerControls = (props: {
  composer: Composer
  connected: boolean
  busy: boolean
  selectMode: (mode: ComposerMode) => void
  submit: () => void
}) => {
  const state = props.composer.state
  const draft = () => (state.mode === "aside" ? state.aside : state.task)
  const modes = ["aside", "queue", "steer"] as const
  const reason = () =>
    !props.connected ? "Disconnected or loading. Reconnect before sending." : props.composer.blockedReason()
  return (
    <div class="composer-controls" data-composer-controls>
      <Show when={state.mode !== "send" || props.busy}>
        <div class="composer-mode-row">
          <div
            class="composer-modes"
            role="radiogroup"
            aria-label="Message delivery"
            aria-keyshortcuts="Alt+M"
            title="Cycle modes: Alt+M (Option+M on Mac)"
          >
            <For each={modes}>
              {(mode, index) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={state.mode === mode}
                  tabIndex={state.mode === mode ? 0 : -1}
                  classList={{ selected: state.mode === mode }}
                  onClick={() => props.selectMode(mode)}
                  onKeyDown={(e) => {
                    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return
                    e.preventDefault()
                    e.stopPropagation()
                    const rtl = getComputedStyle(e.currentTarget).direction === "rtl"
                    const back = e.key === "ArrowUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft")
                    const next = e.key === "Home" ? 0 : e.key === "End" ? 2 : (index() + (back ? 2 : 1)) % 3
                    const group = e.currentTarget.parentElement
                    props.selectMode(modes[next]!)
                    group?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus()
                  }}
                >
                  {mode[0]!.toUpperCase() + mode.slice(1)}
                </button>
              )}
            </For>
          </div>
          <Show when={!props.busy && props.connected}>
            <button aria-label="Use normal Send" title="Use normal Send" onClick={() => props.selectMode("send")}>
              Send
            </button>
          </Show>
        </div>
      </Show>
      <div
        class="composer-summary composer-help dim"
        role="status"
        aria-live="polite"
        title={
          state.mode === "aside"
            ? "Ask about a snapshot without changing the task. Task draft saved; the first Aside starts as a copy."
            : state.mode === "send"
              ? "Send to this session."
              : "Queue and Steer use the session agent and model."
        }
      >
        {state.mode === "aside"
          ? "Snapshot only. Task draft saved."
          : state.mode === "queue"
            ? "Send when the task finishes."
            : state.mode === "steer"
              ? "Send at the next safe boundary."
              : "Send to this session."}
      </div>
      <Show when={reason()}>
        <div class="composer-help dim">{reason()}</div>
      </Show>
      <Show when={state.storageError}>
        <div class="err" role="alert">
          {state.storageError}
          <button onClick={() => props.composer.setImages([])}>Clear saved images</button>
        </div>
      </Show>
      <Show when={state.error}>
        <div class="err" role="alert">
          {state.error}
        </div>
      </Show>
      <div class="composer-actions">
        <button
          class="composer-send"
          title="Cmd/Ctrl+Enter"
          disabled={!!reason() || (!draft().text.trim() && !draft().images.length)}
          onClick={props.submit}
        >
          {props.composer.actionLabel()}
        </button>
      </div>
      <Show when={props.composer.capabilityReason()}>
        <button
          disabled={!props.connected || state.inputLoading}
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

export const ComposerResults = (props: { composer: Composer; connected: boolean }) => {
  const state = props.composer.state
  return (
    <div class="composer-results" data-composer-controls>
      <Show when={state.admission}>
        {(admission) => (
          <section class="input-admission" aria-label="Input admission" aria-live="polite">
            <b>
              {admission().payload.delivery}:{" "}
              {admission().status === "sending" ? "Confirming admission..." : "Admission unknown"}
            </b>
            <p dir="auto">{admission().payload.text}</p>
            <div class="dim">{admission().error}</div>
            <Show when={admission().status === "unknown"}>
              <button disabled={!props.connected || state.inputLoading} onClick={() => props.composer.refreshInputs()}>
                Check admission
              </button>
              <button disabled={!props.connected || state.sending} onClick={() => props.composer.retryAdmission()}>
                Check and retry same input
              </button>
            </Show>
          </section>
        )}
      </Show>
      <Show when={state.receipts.length}>
        <details class="input-receipts" open={!state.asideRequest}>
          <summary>Task inputs ({state.receipts.filter((item) => item.state === "pending").length} pending)</summary>
          <div class="dim">Added to conversation does not mean the model has finished.</div>
          <button disabled={!props.connected || state.inputLoading} onClick={() => props.composer.refreshInputs()}>
            Refresh inputs
          </button>
          <ul>
            <For each={state.receipts}>
              {(item) => (
                <li data-request-id={item.requestID}>
                  <span>
                    <b>{item.delivery}</b>{" "}
                    <span class="dim" role="status">
                      {item.state === "promoted" ? "Added to conversation" : item.state}
                    </span>
                  </span>
                  <p dir="auto">{item.text}</p>
                  <Show when={item.state === "pending"}>
                    <button
                      disabled={!props.connected}
                      aria-label={`Cancel ${item.delivery} input: ${item.text}`}
                      onClick={() => props.composer.cancelInput(item.requestID)}
                    >
                      Cancel input
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
      <Show when={state.asideRequest}>
        {(aside) => (
          <section class="aside-result" aria-label="Aside result">
            <div class="composer-actions">
              <b>Aside</b>
              <span role="status" class="dim">
                {aside().status}
              </span>
              <Show when={aside().status === "running" || aside().status === "unknown"}>
                <button onClick={() => props.composer.cancelAside()}>Cancel aside</button>
              </Show>
              <button onClick={() => props.composer.closeAside()}>Close aside</button>
            </div>
            <p class="aside-question" dir="auto">
              {aside().question}
            </p>
            <Show when={aside().snapshot}>
              {(snapshot) => (
                <div class="dim aside-snapshot">
                  Snapshot {new Date(snapshot().capturedAt).toLocaleString()} · {snapshot().activity.status}
                  <span>
                    Through <bdi>{snapshot().throughMessageID ?? "start of conversation"}</bdi>;{" "}
                    {snapshot().excludedMessageCount} messages excluded
                  </span>
                </div>
              )}
            </Show>
            <Show when={aside().error}>
              <div role="alert" class="err">
                {aside().error}
              </div>
            </Show>
            <Show when={aside().text}>
              <div class="aside-answer" dir="auto" tabIndex={0}>
                {aside().text}
              </div>
            </Show>
          </section>
        )}
      </Show>
    </div>
  )
}

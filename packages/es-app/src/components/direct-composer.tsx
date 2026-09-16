import { For, Show, type JSX } from "solid-js"
import type { Composer, ComposerAction } from "../composer"
import "./direct-composer.css"

export const DirectComposer = (props: {
  composer: Composer
  connected: boolean
  submit: (action: ComposerAction) => void
  restoreDraft: () => void
  activeAgent?: string
  agents: { name: string; description?: string }[]
  agentError?: string
  retryAgents: () => void
  editor: JSX.Element
  attachments: JSX.Element
  sessionActions: JSX.Element
  sessionMetadata?: JSX.Element
  children: JSX.Element
}) => {
  const state = props.composer.state
  const actions = ["steer", "queue", "aside"] as const
  const nextTarget = () => actions[(actions.indexOf(state.keyboardTarget) + 1) % actions.length]
  const label = (action: ComposerAction) => action[0]!.toUpperCase() + action.slice(1)
  const reason = (action: ComposerAction) =>
    !props.connected
      ? "Session unavailable or another session action is running."
      : props.composer.reasonForAction(action)
  const reasons = () => [...new Set(actions.map(reason).filter(Boolean))]
  const other = () => state[state.visibleBuffer === "task" ? "aside" : "task"]
  return (
    <div class="direct-composer" data-composer-controls>
      <div class="direct-writing">
        {props.attachments}
        {props.editor}
        <div class="direct-session-actions" role="group" aria-label="Session actions">
          {props.sessionActions}
          <span class="direct-session-metadata">
            <span class="direct-active-agent">Active agent: {props.activeAgent ?? "session default"}</span>
            {props.sessionMetadata}
          </span>
        </div>
        <Show when={other().text || other().images.length}>
          <button class="direct-recover" onClick={props.restoreDraft}>
            Restore saved {state.visibleBuffer === "task" ? "Aside" : "task"} draft
          </button>
        </Show>
      </div>
      <aside class="direct-controls" aria-label="Message actions and settings">
        <div class="direct-submit-actions" role="group" aria-label="Submit current message">
          <For each={actions}>
            {(action) => (
              <button
                classList={{ "keyboard-target": state.keyboardTarget === action }}
                data-keyboard-target={state.keyboardTarget === action}
                aria-label={label(action)}
                aria-description={
                  state.keyboardTarget === action
                    ? "Current keyboard target; Command or Control plus Enter submits this message."
                    : nextTarget() === action
                      ? "Alt+M selects this keyboard target without submitting; clicking submits directly."
                      : "Click to submit the current visible message."
                }
                aria-keyshortcuts={state.keyboardTarget === action ? "Meta+Enter Control+Enter" : undefined}
                title={reason(action) || `Submit the visible message with ${label(action)}`}
                disabled={
                  !!reason(action) ||
                  (!props.composer.visibleDraft().text.trim() && !props.composer.visibleDraft().images.length)
                }
                onPointerDown={(e) => {
                  const focused = document.activeElement
                  if (
                    focused instanceof HTMLTextAreaElement &&
                    e.currentTarget.closest(".direct-composer")?.contains(focused)
                  )
                    e.preventDefault()
                }}
                onClick={() => props.submit(action)}
              >
                {label(action)}{" "}
                <kbd class="direct-button-hint" aria-hidden="true">
                  {state.keyboardTarget === action ? "⌘/Ctrl↵" : nextTarget() === action ? "Alt+M →" : ""}
                </kbd>
              </button>
            )}
          </For>
        </div>
        <label class="direct-setting">
          <select
            aria-label="Queue agent"
            value={state.queueAgent ?? ""}
            disabled={state.keyboardTarget !== "queue" || !props.agents.length}
            onChange={(e) => props.composer.setQueueAgent(e.currentTarget.value || null)}
          >
            <option value="" selected={!state.queueAgent}>
              {props.activeAgent ? `Current: ${props.activeAgent}` : "Current agent"}
            </option>
            <Show when={state.queueAgent && !props.agents.some((agent) => agent.name === state.queueAgent)}>
              <option value={state.queueAgent!} selected>
                {state.queueAgent} (saved)
              </option>
            </Show>
            <For each={props.agents}>
              {(agent) => (
                <option value={agent.name} selected={state.queueAgent === agent.name} title={agent.description}>
                  {agent.name}
                </option>
              )}
            </For>
          </select>
        </label>
        <div class="direct-model" role="group" aria-label="Model settings">
          {props.children}
        </div>
      </aside>
      <Show when={props.agentError}>
        <div class="direct-feedback err" role="alert">
          Agent list unavailable. <button onClick={props.retryAgents}>Retry agents</button>
        </div>
      </Show>
      <Show when={reasons().length}>
        <div class="direct-feedback dim">
          <For each={reasons()}>{(value) => <div>{value}</div>}</For>
        </div>
      </Show>
      <Show when={state.storageError}>
        <div class="direct-feedback err" role="alert">
          {state.storageError}
          <button onClick={() => props.composer.setImages([], state.visibleBuffer)}>Clear saved images</button>
        </div>
      </Show>
      <Show when={state.error}>
        <div class="direct-feedback err" role="alert">
          {state.error}
        </div>
      </Show>
      <Show when={!state.capabilities || state.capabilityError}>
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

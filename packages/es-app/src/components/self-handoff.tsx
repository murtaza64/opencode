import { For, Show, type JSX } from "solid-js"
import { Glyph } from "./icons"
import { selfHandoffText, type createSelfHandoff } from "../self-handoff"

type Handoff = ReturnType<typeof createSelfHandoff>
/** Why the button cannot start a handoff here, or undefined when it can. */
export type SelfHandoffGate = string | undefined

/** The composer's Self-handoff action (CHAT-13). Disabled with its reason when this host cannot do it here. */
export const SelfHandoffButton = (props: { handoff: Handoff; gate: SelfHandoffGate }) => {
  const busy = () => !["idle", "failed", "error"].includes(props.handoff.state().state)
  return <button class="act-self-handoff" disabled={!!props.gate || busy()}
    title={props.gate ?? "Ask this agent to write a handoff and start its successor, which then owns the lane"}
    onClick={() => void props.handoff.start()}>
    <Glyph name="sync" /><span class="action-label">Self-handoff</span>
  </button>
}

/** What the request is doing, in words, below the composer. Every state comes from the dashboard's replies. */
export const SelfHandoffStatus = (props: { handoff: Handoff; successor: (id: string) => JSX.Element }) => {
  const state = () => props.handoff.state()
  return <Show when={state().state !== "idle"}>
    <div class="self-handoff-status" data-state={state().state} role="status" aria-live="polite">
      <span class="self-handoff-text" dir="auto">{selfHandoffText(state())}</span>
      <Show when={state().state === "confirm"}>
        <button class="desk-button home-primary" onClick={() => void props.handoff.start(true)}>Hand off on this model</button>
        <button class="desk-button" onClick={() => props.handoff.decline()}>Not now</button>
      </Show>
      <Show when={state().state === "requested"}><button class="desk-button" onClick={() => void props.handoff.cancel()}>Cancel handoff</button></Show>
      <Show when={(() => { const value = state(); return value.state === "verified" ? value : undefined })()}>{(value) => <>
        <span class="self-handoff-successor">Successor: {props.successor(value().successor)}</span>
        {/* Settings the successor did not inherit are named, never implied carried. */}
        <Show when={value().notCarried.length}>
          <span class="self-handoff-not-carried">Not carried over: <For each={value().notCarried}>{(item, index) => <>{index() ? ", " : ""}<bdi dir="auto">{item}</bdi></>}</For></span>
        </Show>
      </>}</Show>
      <Show when={state().state === "failed" || state().state === "error"}>
        <button class="desk-button" onClick={() => state().state === "failed" ? props.handoff.reset() : void props.handoff.start()}>
          {state().state === "failed" ? "Dismiss" : "Retry same request"}</button>
      </Show>
    </div>
  </Show>
}

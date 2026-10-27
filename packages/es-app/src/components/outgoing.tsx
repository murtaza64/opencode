import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Composer } from "../composer"
import { ChatImages } from "./chat-images"

// Every input the transcript does not show yet, as one outgoing bubble with a
// one-line cue. Durable states (admission, receipt, set-aside recovery, normal
// send) collapse to Sending / Queued / Steer / Sent / Not confirmed yet / Not sent.
// Full errors and request IDs live in the cue's title, never in extra rows.
// Bubbles are keyed by request identity, so admission -> pending receipt keeps
// the same element and position.
export type RunningTool = { name: string; at?: number }

export const OutgoingMessages = (props: {
  composer: Composer; connected: boolean; echo: boolean; session?: Session; busy?: boolean; running?: RunningTool
}) => {
  const state = props.composer.state
  const receipts = () => state.receipts.filter((item) => item.state === "pending" && item.source?.type !== "editspace-mail")
  // The handoff banner owns a fenced admission; an acknowledged one is already a receipt.
  const admission = () => {
    const current = state.admission
    if (!current || current.fence || receipts().some((item) => item.requestID === current.payload.requestID)) return undefined
    return current
  }
  // A set-aside input that has since been reconciled to a pending receipt shows as that receipt.
  const recoveries = () => state.recoveries.filter((entry) => !receipts().some((item) => item.requestID === entry.admission.payload.requestID))
  const ids = createMemo(() => [
    ...recoveries().map((entry) => entry.admission.payload.requestID),
    ...receipts().map((item) => item.requestID),
    ...(admission() ? [admission()!.payload.requestID] : []),
  ], undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) })
  return (
    <div class="outgoing" data-composer-controls>
      <Show when={ids().length}>
        <ul class="outgoing-list input-receipts" aria-label="Pending inputs">
          <For each={ids()}>{(id) => <InputBubble composer={props.composer} connected={props.connected} id={id} busy={props.busy} running={props.running} />}</For>
        </ul>
      </Show>
      <Show when={props.echo && state.normalSubmission}>
        {(submission) => (
          <section class="pending-msg outgoing-item outgoing-msg" data-status={submission().status} aria-label="Message status">
            <ChatImages images={submission().previews} />
            <Show when={submission().text || !submission().previews?.length}>
              <div class="pending-bubble" dir="auto">{submission().text}{submission().images && !submission().previews?.length ? ` · ${submission().images} image(s)` : ""}</div>
            </Show>
            <div class="pending-hint outgoing-cue" role="status" title={[submission().error, submission().messageID && `Message ${submission().messageID}`].filter(Boolean).join("\n") || undefined}>
              <span>{submission().status === "sending" || submission().checking ? "Sending…" : submission().status === "accepted" ? "Sent"
                : submission().absent ? "Not sent" : "Not confirmed yet"}</span>
              <Show when={submission().status === "unknown"}>
                <Show when={submission().messageID && !submission().absent}>
                  <button class="outgoing-action" title="Looks the message up by its ID; never resends"
                    disabled={submission().checking || !props.connected} onClick={() => void props.composer.checkSubmission()}>Check</button>
                </Show>
                <Show when={submission().absent && props.session}>
                  {(session) => (
                    <button class="outgoing-action" title="Resends under the same message ID, so it cannot duplicate"
                      disabled={state.sending || !props.connected} onClick={() => void props.composer.sendAgain(session())}>Send again</button>
                  )}
                </Show>
                <Show when={submission().draft}>
                  <button class="outgoing-action" aria-label="Edit unconfirmed message" title="Moves it back into the editor; a resend is a new message"
                    disabled={!!props.composer.visibleDraft().text || !!props.composer.visibleDraft().images.length}
                    onClick={() => props.composer.editNormalSubmission()}>Edit</button>
                </Show>
                <button class="outgoing-action" aria-label="Dismiss send status" onClick={() => props.composer.dismissNormalSubmission()}>Dismiss</button>
              </Show>
            </div>
          </section>
        )}
      </Show>
    </div>
  )
}

const InputBubble = (props: { composer: Composer; connected: boolean; id: string; busy?: boolean; running?: RunningTool }) => {
  const state = props.composer.state
  const receipt = () => state.receipts.find((item) => item.requestID === props.id && item.state === "pending")
  const admission = () => receipt() ? undefined : state.admission?.payload.requestID === props.id ? state.admission : undefined
  const recovery = () => receipt() || admission() ? undefined : state.recoveries.find((entry) => entry.admission.payload.requestID === props.id)
  const payload = () => admission()?.payload ?? recovery()?.admission.payload
  const delivery = () => receipt()?.delivery ?? payload()?.delivery ?? "queue"
  const text = () => receipt()?.text ?? payload()?.text ?? ""
  const images = () => receipt()?.images ?? payload()?.images
  const status = () => receipt() ? "pending" : recovery() ? "unknown" : admission()?.status
  // Core's last answer for a set-aside input, if it has one.
  const settled = () => recovery() ? state.receipts.find((item) => item.requestID === props.id)?.state : undefined
  const check = () => state.inputChecks[props.id]
  const unconfirmed = () => admission()?.status === "unknown" || (!!recovery() && !settled())
  const cue = () => {
    const kind = delivery() === "steer" ? "Steer" : "Queued"
    if (receipt() && delivery() === "steer") {
      // A steer reaches the model only after every tool call of the current turn finishes.
      if (props.running) return `Steer · waiting for ${props.running.name} to finish${elapsed() ? ` · ${elapsed()}` : ""}`
      if (!props.busy) return "Steer · not delivered; the session stopped"
      return "Steer · at the next safe point"
    }
    if (receipt()) return "Queued · after this task"
    if (settled()) return settled() === "pending" ? (delivery() === "steer" ? "Steer · at the next safe point" : "Queued · after this task")
      : settled() === "cancelled" ? "Cancelled" : "Sent"
    // An unknown outcome reads as still sending only while its readback is in flight; after that it
    // says what is known, so a lost answer never shows an indefinite "sending…".
    if (admission()?.status === "sending" || check() === "checking") return `${kind} · sending…`
    return check() === "absent" ? "Not sent" : "Not confirmed yet"
  }
  const title = () => [recovery() ? state.recoveryError : admission()?.error, admission() && state.recoveryError.startsWith("Cannot save this unknown input") && state.recoveryError, `Request ${props.id}`]
    .filter(Boolean).join("\n")
  const editing = () => props.composer.editingInput() === props.id
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 15_000)
  onCleanup(() => clearInterval(timer))
  const elapsed = () => {
    const at = props.running?.at
    if (at === undefined) return ""
    const minutes = Math.floor((now() - at) / 60_000)
    return minutes < 1 ? "" : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
  const deliverable = () => receipt() && delivery() === "steer" && state.capabilities?.sessionInput?.interrupt
  return (
    <li class="pending-msg outgoing-item outgoing-msg" data-request-id={props.id} data-delivery={delivery()}
      data-status={status()} data-recovery-id={recovery() ? props.id : undefined}
      classList={{ "input-admission": !!admission(), "input-recovery": !!recovery() }}
      aria-label={admission() ? "Input admission" : recovery() ? "Set-aside input" : undefined}>
      <ChatImages images={images()} />
      <Show when={text() || !images()?.length}><div class="pending-bubble receipt-text" dir="auto">{text()}</div></Show>
      <div class="pending-hint outgoing-cue receipt-row" role="status" title={title()}>
        <span>{cue()}</span>
        <Show when={deliverable()}>
          <button class="outgoing-action outgoing-deliver" disabled={!props.connected || !!state.delivering}
            aria-label={`${props.busy ? "Interrupt and steer now" : "Steer now"}: ${text()}`}
            title={props.busy
              ? `Stops ${props.running ? `${props.running.name} (its output so far is kept)` : "the current reply"} and starts the next turn with this steer. Nothing is rerun.`
              : "Starts a turn with this steer."}
            onClick={() => void props.composer.deliverInput(props.id)}>
            {state.delivering === props.id ? "Steering…" : props.busy ? "Interrupt and steer now" : "Steer now"}
          </button>
        </Show>
        <Show when={receipt()}>
          <Show when={state.capabilities?.sessionInput?.update}>
            <button class="outgoing-action" disabled={!props.connected || !!props.composer.editingInput()}
              aria-label={`Edit ${delivery()} input: ${text()}`} aria-pressed={editing()}
              onClick={() => props.composer.editInput(props.id)}>{editing() ? "Editing" : "Edit"}</button>
          </Show>
          <button class="outgoing-action receipt-cancel" disabled={!props.connected}
            aria-label={`Cancel ${delivery()} input: ${text()}`} onClick={() => props.composer.cancelInput(props.id)}>Cancel</button>
        </Show>
        {/* One action at a time: Check while the outcome is unknown, Retry only once Core said it has no such input. */}
        <Show when={unconfirmed() && check() !== "checking"}>
          <Show when={check() === "absent"} fallback={admission()
            ? <button class="outgoing-action" aria-label="Check admission" title="Looks the input up by its request ID; never resends"
                disabled={!props.connected || state.inputLoading} onClick={() => props.composer.refreshInputs()}>Check</button>
            : <button class="outgoing-action" aria-label="Check set-aside input" title="Looks the input up by its request ID; never resends"
                disabled={!props.connected || !!state.recoveryBusy} onClick={() => props.composer.recoverAdmission(props.id)}>Check</button>}>
            <Show when={admission()} fallback={
              <button class="outgoing-action" aria-label="Check and retry same set-aside input" title="Checks first; a retry reuses this exact request, so it cannot duplicate"
                disabled={!props.connected || !!state.recoveryBusy} onClick={() => props.composer.recoverAdmission(props.id, true)}>Retry</button>}>
              <button class="outgoing-action" aria-label="Check and retry same input" title="Checks first; a retry reuses this exact request, so it cannot duplicate"
                disabled={!props.connected || state.sending} onClick={() => props.composer.retryAdmission()}>Retry</button>
            </Show>
          </Show>
        </Show>
      </div>
    </li>
  )
}

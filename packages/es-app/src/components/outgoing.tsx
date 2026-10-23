import { createMemo, For, Show } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Composer } from "../composer"
import { ComposerImages } from "./composer-images"

// Every input the transcript does not show yet, as one outgoing bubble with a
// one-line cue. Durable states (admission, receipt, set-aside recovery, normal
// send) collapse to Sending / Queued / Steer / Sent / Not confirmed / Set aside.
// Full errors and request IDs live in the cue's title, never in extra rows.
// Bubbles are keyed by request identity, so admission -> pending receipt keeps
// the same element and position.
export const OutgoingMessages = (props: { composer: Composer; connected: boolean; echo: boolean; session?: Session }) => {
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
          <For each={ids()}>{(id) => <InputBubble composer={props.composer} connected={props.connected} id={id} />}</For>
        </ul>
      </Show>
      <Show when={props.echo && state.normalSubmission}>
        {(submission) => (
          <section class="pending-msg outgoing-item outgoing-msg" data-status={submission().status} aria-label="Message status">
            <Show when={submission().text || !submission().previews?.length}>
              <div class="pending-bubble" dir="auto">{submission().text}{submission().images && !submission().previews?.length ? ` · ${submission().images} image(s)` : ""}</div>
            </Show>
            <ComposerImages images={submission().previews} />
            <div class="pending-hint outgoing-cue" role="status" title={[submission().error, submission().messageID && `Message ${submission().messageID}`].filter(Boolean).join("\n") || undefined}>
              <span>{submission().status === "sending" ? "Sending…" : submission().status === "accepted" ? "Sent"
                : submission().checking ? "Not confirmed · checking…"
                : submission().absent ? "Not confirmed · the server has no record of it" : "Not confirmed; it may still arrive"}</span>
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

const InputBubble = (props: { composer: Composer; connected: boolean; id: string }) => {
  const state = props.composer.state
  const receipt = () => state.receipts.find((item) => item.requestID === props.id && item.state === "pending")
  const admission = () => receipt() ? undefined : state.admission?.payload.requestID === props.id ? state.admission : undefined
  const recovery = () => receipt() || admission() ? undefined : state.recoveries.find((entry) => entry.admission.payload.requestID === props.id)
  const payload = () => admission()?.payload ?? recovery()?.admission.payload
  const delivery = () => receipt()?.delivery ?? payload()?.delivery ?? "queue"
  const text = () => receipt()?.text ?? payload()?.text ?? ""
  const images = () => receipt()?.images ?? payload()?.images
  const status = () => receipt() ? "pending" : recovery() ? "unknown" : admission()?.status
  const cue = () => {
    const kind = delivery() === "steer" ? "Steer" : "Queued"
    if (receipt()) return delivery() === "steer" ? "Steer · at the next safe point" : "Queued · after this task"
    if (recovery()) {
      const settled = state.receipts.find((item) => item.requestID === props.id)?.state
      return settled ? `Set aside · ${settled}` : "Set aside, not confirmed"
    }
    return admission()?.status === "sending" ? `${kind} · sending…` : `Not confirmed · ${kind.toLowerCase()}`
  }
  const title = () => [recovery() ? state.recoveryError : admission()?.error, `Request ${props.id}`].filter(Boolean).join("\n")
  const editing = () => props.composer.editingInput() === props.id
  return (
    <li class="pending-msg outgoing-item outgoing-msg" data-request-id={props.id} data-delivery={delivery()}
      data-status={status()} data-recovery-id={recovery() ? props.id : undefined}
      classList={{ "input-admission": !!admission(), "input-recovery": !!recovery() }}
      aria-label={admission() ? "Input admission" : recovery() ? "Set-aside input" : undefined}>
      <div class="pending-bubble receipt-text" dir="auto">{text()}</div>
      <ComposerImages images={images()} />
      <div class="pending-hint outgoing-cue receipt-row" role="status" title={title()}>
        <span>{cue()}</span>
        <Show when={receipt()}>
          <Show when={state.capabilities?.sessionInput?.update}>
            <button class="outgoing-action" disabled={!props.connected || !!props.composer.editingInput()}
              aria-label={`Edit ${delivery()} input: ${text()}`} aria-pressed={editing()}
              onClick={() => props.composer.editInput(props.id)}>{editing() ? "Editing" : "Edit"}</button>
          </Show>
          <button class="outgoing-action receipt-cancel" disabled={!props.connected}
            aria-label={`Cancel ${delivery()} input: ${text()}`} onClick={() => props.composer.cancelInput(props.id)}>Cancel</button>
        </Show>
        <Show when={admission()?.status === "unknown"}>
          <button class="outgoing-action" aria-label="Check admission" disabled={!props.connected || state.inputLoading}
            onClick={() => props.composer.refreshInputs()}>Check</button>
          <button class="outgoing-action" aria-label="Check and retry same input" title="Checks first; a retry reuses this exact request, so it cannot duplicate"
            disabled={!props.connected || state.sending} onClick={() => props.composer.retryAdmission()}>Retry</button>
          <button class="outgoing-action" aria-label="Set aside unknown input" title="Keeps it locally without resending or cancelling it"
            disabled={state.sending || state.hydrating} onClick={() => props.composer.setAsideAdmission()}>Set aside</button>
        </Show>
        <Show when={recovery()}>
          <button class="outgoing-action" aria-label="Check set-aside input" disabled={!props.connected || !!state.recoveryBusy}
            onClick={() => props.composer.recoverAdmission(props.id)}>Check</button>
          <button class="outgoing-action" aria-label="Check and retry same set-aside input" title="Checks first; a retry reuses this exact request, so it cannot duplicate"
            disabled={!props.connected || !!state.recoveryBusy} onClick={() => props.composer.recoverAdmission(props.id, true)}>Retry</button>
        </Show>
      </div>
    </li>
  )
}

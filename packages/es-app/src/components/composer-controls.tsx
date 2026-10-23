import { For, Show } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import type { Composer } from "../composer"
import type { Session } from "@opencode-ai/sdk/v2"
import { ComposerImages } from "./composer-images"

export const ComposerResults = (props: { composer: Composer; connected: boolean; session?: Session }) => {
  const state = props.composer.state
  const pending = () => state.receipts.filter((item) => item.state === "pending" && item.source?.type !== "editspace-mail")
  const queued = () => pending().filter((item) => item.delivery === "queue").length
  const steers = () => pending().filter((item) => item.delivery === "steer").length
  return (
    <div class="composer-results" data-composer-controls>
      {/* In-flight sends show only in the transcript echo; this row appears for an outcome that
          needs the human (unknown), so a routine send never inserts and removes a row here. */}
      <Show when={state.normalSubmission?.status === "unknown" && state.normalSubmission}>
        {(submission) => (
          <section class="normal-submission" aria-label="Message status">
            <div class="composer-actions">
              <span role="status">
                <b>Not confirmed</b> · {submission().checking ? "checking…"
                  : submission().absent ? "the server has no record of it"
                  : submission().messageID ? "will check again when the server answers" : "check the conversation"}
              </span>
              <Show when={submission().messageID && !submission().absent}>
                <button disabled={submission().checking || !props.connected} onClick={() => void props.composer.checkSubmission()}>Check</button>
              </Show>
              <Show when={submission().absent && props.session}>
                {(session) => <button disabled={state.sending || !props.connected} onClick={() => void props.composer.sendAgain(session())}>Send again</button>}
              </Show>
              <button aria-label="Dismiss send status" onClick={() => props.composer.dismissNormalSubmission()}>
                Dismiss
              </button>
            </div>
            <p dir="auto">
              {submission().text}
              {submission().images ? ` [${submission().images} image(s)]` : ""}
            </p>
          </section>
        )}
      </Show>
      {/* A routine admission reports in the work-status slot; this row is for an unknown outcome. */}
      <Show when={state.admission && !state.admission.fence && state.admission.status !== "sending" ? state.admission : undefined}>
        {(admission) => (
          <section class="input-admission" aria-label="Input admission" aria-live="polite">
            <b>
              {admission().payload.delivery}:{" "}
              {admission().status === "sending" ? "Confirming admission..." : "Admission unknown"}
            </b>
            <p dir="auto">{admission().payload.text}</p>
            <ComposerImages images={admission().payload.images} />
            <div class="dim">{admission().error}</div>
            <Show when={admission().status === "unknown"}>
              <button disabled={!props.connected || state.inputLoading} onClick={() => props.composer.refreshInputs()}>
                Check admission
              </button>
              <button disabled={!props.connected || state.sending} onClick={() => props.composer.retryAdmission()}>
                Check and retry same input
              </button>
              <button disabled={state.sending || state.hydrating} onClick={() => props.composer.setAsideAdmission()}>
                Set aside unknown input
              </button>
              <p class="dim">Does not resend or cancel it.</p>
            </Show>
          </section>
        )}
      </Show>
      <Show when={state.recoveryError}>
        <p class="err" role="alert">{state.recoveryError}</p>
      </Show>
      <Show when={state.recoveries.length}>
        <details class="input-recoveries">
          <summary>Not confirmed ({state.recoveries.length})</summary>
          <For each={state.recoveries}>
            {(entry) => (
              <section aria-label="Set-aside input" data-recovery-id={entry.admission.payload.requestID}>
                <b>{entry.admission.payload.delivery} · {state.receipts.find((item) => item.requestID === entry.admission.payload.requestID)?.state ?? "not confirmed"}</b>
                <p dir="auto">{entry.admission.payload.text}</p>
                <ComposerImages images={entry.admission.payload.images} />
                <p class="dim">Request <bdi>{entry.admission.payload.requestID}</bdi>. Kept locally; not cancelled.</p>
                <button disabled={!props.connected || !!state.recoveryBusy} onClick={() => props.composer.recoverAdmission(entry.admission.payload.requestID)}>
                  Check set-aside input
                </button>
                <button disabled={!props.connected || !!state.recoveryBusy} onClick={() => props.composer.recoverAdmission(entry.admission.payload.requestID, true)}>
                  Check and retry same set-aside input
                </button>
              </section>
            )}
          </For>
        </details>
      </Show>
      <Show when={pending().length}>
        {/* every listed receipt is server-accepted and still pending delivery; the
          * header carries the counts and refresh so rows stay one line each */}
        <details class="input-receipts" open={!state.asideRequest}>
          <summary>
            <span class="receipts-title">Pending inputs</span>
            <span class="dim receipts-counts" dir="ltr">({queued()} queued, {steers()} steer)</span>
            <button
              class="receipts-refresh"
              aria-label="Refresh inputs"
              title="Refresh inputs"
              disabled={!props.connected || state.inputLoading}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void props.composer.refreshInputs()
              }}
            >
              ↻
            </button>
          </summary>
          <ul>
            <For each={pending()}>
              {(item) => (
                <li data-request-id={item.requestID}>
                  <div class="receipt-row">
                    <span class={`receipt-kind ${item.delivery}`}>{item.delivery}</span>
                    <p class="receipt-text" dir="auto">{item.text}</p>
                    <Show when={state.capabilities?.sessionInput?.update}>
                      {/* Edits open in the main composer, one at a time. */}
                      <button disabled={!props.connected || !!props.composer.editingInput()}
                        aria-label={`Edit ${item.delivery} input: ${item.text}`}
                        aria-pressed={props.composer.editingInput() === item.requestID}
                        onClick={() => props.composer.editInput(item.requestID)}>
                        {props.composer.editingInput() === item.requestID ? "Editing" : "Edit"}
                      </button>
                    </Show>
                    <button
                      class="receipt-cancel"
                      disabled={!props.connected}
                      aria-label={`Cancel ${item.delivery} input: ${item.text}`}
                      onClick={() => props.composer.cancelInput(item.requestID)}
                    >
                      Cancel
                    </button>
                  </div>
                  <ComposerImages images={item.images} />
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
            <ComposerImages images={aside().images} />
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
                <Markdown text={aside().text!} cacheKey={`aside:${aside().requestID}`} />
              </div>
            </Show>
          </section>
        )}
      </Show>
    </div>
  )
}

import { Show } from "solid-js"
import { useDashboard } from "../state"
import { failureLabel, retryLabel, unavailableReason, type RetryResult } from "../session-failures"

const settled = (result: RetryResult | undefined) => result?.outcome === "accepted" || result?.outcome === "running"

/** Per-session Retry with its inline outcome. Renders nothing unless the session is failed. */
export const FailureRetry = (props: { sessionID: string; compact?: boolean }) => {
  const { failures, handedOff } = useDashboard()
  const failure = () => (handedOff(props.sessionID) ? undefined : failures.failure(props.sessionID))
  const state = () => failures.retryState(props.sessionID)
  const sending = () => state()?.phase === "sending"
  const result = () => { const value = state(); return value?.phase === "done" ? value.result : undefined }
  return (
    <Show when={failure() || (result() && !settled(result()))}>
      <span class="failure-retry" data-compact={props.compact ? "" : undefined}>
        <Show when={failure()}>
          {(item) => (
            <Show when={item().retry === "available"} fallback={
              <span class="failure-note" title={item().retry === "out-of-order"
                ? "Newer steps would sort before the failed one, so a retry could not track its progress."
                : "The failed step ran tools; retrying could repeat or hide their effects."}>
                Retry unavailable: {unavailableReason(item())}
              </span>
            }>
              <button type="button" class="failure-retry-button" disabled={sending()}
                aria-label={`Retry failed turn${props.compact ? "" : `: ${failureLabel(item())}`}`}
                onClick={() => void failures.retry(item())}>
                {sending() ? "Retrying…" : "Retry"}
              </button>
            </Show>
          )}
        </Show>
        <Show when={result()}>
          {(value) => <span class="failure-note" role="status" data-outcome={value().outcome}>{retryLabel(value())}</span>}
        </Show>
      </span>
    </Show>
  )
}

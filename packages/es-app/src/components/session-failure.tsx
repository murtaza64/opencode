import { createSignal, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import type { SessionFailure } from "@opencode-ai/sdk/v2"
import { sessionHref, useDashboard } from "../state"
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

/** Scoped bulk control: retries every retryable failed root in the current sidebar scope. */
export const ResumeAllFailed = () => {
  const { scopedFailures, failures, allProjects, sessionRows } = useDashboard()
  const [running, setRunning] = createSignal(false)
  const [report, setReport] = createSignal<{ failure: SessionFailure; result: RetryResult | undefined }[]>()
  const retryable = () => scopedFailures().filter((item) => item.retry === "available")
  const title = (id: string) => sessionRows().find((row) => row.id === id)?.title || id
  const run = async () => {
    if (running()) return
    setRunning(true)
    setReport(undefined)
    try { setReport(await failures.retryAll(retryable())) } finally { setRunning(false) }
  }
  const summary = () => {
    const rows = report() ?? []
    const started = rows.filter((row) => settled(row.result)).length
    return `${started} of ${rows.length} resumed${rows.length - started ? `; ${rows.length - started} not resumed` : ""}`
  }
  return (
    // An outage shows even with nothing cached: an empty list must not read as "none failed".
    <Show when={failures.error() || (failures.supported() && (scopedFailures().length || report()))}>
      <section class="failed-section" aria-label="Failed sessions">
        <Show when={failures.supported() && scopedFailures().length}>
          <div class="failed-heading">
            <span class="dot failed" aria-hidden="true" />
            <span>{scopedFailures().length} failed{allProjects() ? "" : " in this project"}</span>
            <Show when={retryable().length}>
              <button type="button" class="failure-retry-button" disabled={running()} onClick={() => void run()}
                title="Continue each failed turn from where it stopped; steps that cannot be retried safely are skipped">
                {running() ? "Resuming…" : `Resume all failed (${retryable().length})`}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={report()}>
          <div class="failed-report" role="status">
            <span>{summary()}</span>
            <For each={(report() ?? []).filter((row) => !settled(row.result))}>{(row) => (
              <A href={sessionHref(row.failure.sessionID, row.failure.directory)} class="failure-note">
                <bdi dir="auto">{title(row.failure.sessionID)}</bdi>: {row.result ? retryLabel(row.result) : "Already retrying"}
              </A>
            )}</For>
            <button type="button" class="failure-dismiss" aria-label="Dismiss resume report" onClick={() => setReport(undefined)}>×</button>
          </div>
        </Show>
        <Show when={failures.error()}><div class="failure-note" role="status">{failures.error()}</div></Show>
      </section>
    </Show>
  )
}

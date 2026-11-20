import { createEffect, createResource, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { ApiStatusError, es, type MailMessage, type MailWakeResult, type MailWakeStatus } from "../api"
import { blockedReason, unreadWakeLine } from "../mail-ticks"

// Unread passive mail and Wake now (Loupe mail-ticks.md, DD #414). The next wake comes from the dashboard's real
// schedulers (GET /es/api/mail/wake, es.mail.wake/v1), read only while this session has unread mail and again on a
// mail revision: no timer reads. Wake now posts once to the dashboard, which re-offers the existing admissions with
// their own request ids (a busy agent reads them at its next safe point; repeat clicks coalesce there).

export const createMailWake = (input: { editspace: Accessor<string | undefined>; session: string; unread: Accessor<number>; revision: Accessor<unknown> }) => {
  const [status, { refetch }] = createResource(
    () => { const name = input.editspace(); return name && input.unread() > 0 ? { name, revision: input.revision() } : undefined },
    ({ name }) => es.mailWake(name, input.session).then((body) => body.schema === "es.mail.wake/v1" ? body : undefined, () => undefined),
  )
  // A local clock for the countdown only, while a scheduler holds a time: minute steps, seconds in the last minute.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const at = status()?.state === "scheduled" ? status()?.next?.at_ms : undefined
    if (at == null) return
    const left = at - Date.now()
    const timer = setInterval(() => setNow(Date.now()), left < 60_000 ? 1000 : 30_000)
    onCleanup(() => clearInterval(timer))
  })
  const line = (message: MailMessage) => unreadWakeLine({ status: status(), unavailable: status.state === "ready" && !status(),
    deliveries: message.deliveries, sessionID: input.session, now: now() })
  return { status, refetch, line }
}

type Phase = { kind: "idle" } | { kind: "waking" } | { kind: "done"; text: string } | { kind: "failed"; why: string }

/** The dashboard answers a wake at once (it re-offers admissions and returns); past this the request is reported as
 * failed instead of leaving the button pending. A retry is safe: the runtime coalesces repeated offers. */
export const WAKE_TIMEOUT_MS = 10_000
/** How long an outcome stays before the button offers Wake now again (unless the mail is read first). */
const OUTCOME_MS = 8_000

/** What one Wake now did, from the dashboard's answer. */
export const wakeOutcome = (body: MailWakeResult): Phase => {
  if (body.state?.state === "blocked") return { kind: "failed", why: blockedReason(body.state.next?.reason) }
  if (body.busy) return { kind: "done", text: "Already running · reads it at its next safe point" }
  if (!body.offered) return { kind: "done", text: "Nothing to re-offer · the mail is already with the agent" }
  return { kind: "done", text: "Woken" }
}

/** One per session, above the composer, only while unread passive mail exists: `3 unread · Wake now`. */
export const MailWakeBar = (props: { unread: number; status: MailWakeStatus | undefined; editspace: string | undefined; session: string; onWoke: () => void }) => {
  const [phase, setPhase] = createSignal<Phase>({ kind: "idle" })
  // The unread count dropping (the agent was shown the mail) ends an outcome; a new batch starts idle again.
  let seen = props.unread
  createEffect(() => {
    if (props.unread < seen && phase().kind === "done") setPhase({ kind: "idle" })
    seen = props.unread
  })
  // An outcome is shown for a few seconds, never indefinitely.
  createEffect(() => {
    if (phase().kind !== "done") return
    const timer = setTimeout(() => setPhase({ kind: "idle" }), OUTCOME_MS)
    onCleanup(() => clearTimeout(timer))
  })
  const blocked = () => props.status?.state === "blocked" ? props.status : undefined
  // Passive review off: the button delivers the pending batch now without resuming the schedule (h-r N2).
  const paused = () => props.status?.state === "paused"
  const wake = async () => {
    if (!props.editspace || phase().kind === "waking") return
    setPhase({ kind: "waking" })
    const result = await es.wakeNow(props.editspace, props.session, AbortSignal.timeout(WAKE_TIMEOUT_MS)).then((body) => ({ body }), (error: unknown) => ({ error }))
    if ("error" in result) {
      const status = result.error instanceof ApiStatusError ? result.error.status : undefined
      const timedOut = result.error instanceof DOMException && result.error.name === "TimeoutError"
      return setPhase({ kind: "failed", why: timedOut ? `no answer from the dashboard in ${WAKE_TIMEOUT_MS / 1000} s` : status === 401 || status === 403 ? "operator connection unavailable" : status === 404 ? "this dashboard has no wake route" : status ? `the dashboard answered HTTP ${status}` : "the dashboard did not confirm it" })
    }
    const outcome = wakeOutcome(result.body)
    setPhase(outcome)
    if (outcome.kind === "done") props.onWoke()
  }
  const label = () => {
    const current = phase()
    if (current.kind === "waking") return "Waking…"
    if (current.kind === "failed") return "Retry"
    return paused() ? "Deliver now" : "Wake now"
  }
  return <Show when={props.unread > 0}>
    <div class="mail-wake-bar" role="status" data-phase={phase().kind}>
      <span class="mail-wake-count">{props.unread} unread</span>
      <span class="mail-wake-sep" aria-hidden="true">·</span>
      <Show when={blocked()} fallback={<>
        <Show when={phase().kind === "done"}>
          <span class="mail-wake-outcome">{(phase() as { text: string }).text}</span>
          <span class="mail-wake-sep" aria-hidden="true">·</span>
        </Show>
        <Show when={phase().kind === "failed"}>
          <span class="mail-wake-error" role="alert">Couldn't wake: {(phase() as { why: string }).why}</span>
          <span class="mail-wake-sep" aria-hidden="true">·</span>
        </Show>
        <button type="button" class="mail-wake-now" disabled={phase().kind === "waking" || !props.editspace}
          title={paused() ? "Passive review is off: delivers the unread mail now without resuming the schedule" : "Delivers the unread mail to the agent now; a working agent reads it at its next safe point"}
          onClick={() => void wake()}>{label()}</button>
      </>}>{(status) => <span class="mail-wake-blocked">Blocked: {blockedReason(status().next?.reason)}</span>}</Show>
    </div>
  </Show>
}

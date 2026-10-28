import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { clearBackend, describeFailure, reportBackend } from "./backend-status"

export type AttentionRecord = {
  id: string
  editspace: string
  revision: number
  /** Revision of the last publish/update; answer/snooze/wake leave it. Absent on older records. */
  content_revision?: number
  status: "open" | "snoozed" | "decided" | "answered" | "resolved" | "withdrawn"
  lane?: string | null
  kind: "decision" | "blocker"
  title: string
  context: string
  options: AttentionOption[]
  recommendation?: string | null
  producer_session: string
  origin_session: string
  gate_key: string
  /** A question in a series from one producer origin (attention S5): stable index, gaps allowed. */
  series?: { id: string; index: number; title?: string } | null
  source_ref: { session_id: string; directory: string }
  decision: { choice_id: string; label?: string } | string | null
  delivery_state: DeliveryState
  /** `brief`: the prepared brief shown when answering, so History can reopen exactly that explanation. */
  answer?: { id: string; text: string; choice_id: string | null; input_value?: InputValue; answered_at: number; revision?: number; brief?: { job: string; revision: string } | null } | null
  delivery?: {
    state: DeliveryState
    reason: string | null
    lane: string | null
    session: string | null
    session_directory?: string | null
    message_id: string | null
    error: string | null
    updated_at: number
    presented_at: string | null
    handled_at: string | null
    copies?: { session: string; directory?: string | null; state: string; error: string | null; presented_at: string | null; handled_at: string | null }[]
  } | null
  created_at: number
  updated_at: number
  snoozed_until?: number | null
}
/** What an option asks the human to supply with it; the ledger refuses the answer when a required value is missing or invalid. */
export type OptionInput = {
  kind: "text" | "choice" | "multi" | "secret" | (string & {})
  label: string
  required?: boolean
  hint?: string
  choices?: { id: string; label: string }[]
  max?: number
  /** `secret` only: values go through the secure intake route (secret-field.ts), never an answer. */
  consumer?: string
  handle?: string
  fields?: { id: string; label: string }[]
}
export type AttentionOption = { id: string; label: string; input?: OptionInput }
export type InputValue = string | string[]
export const INPUT_KINDS = ["text", "choice", "multi", "secret"]

/** Why `value` cannot be sent with `option`, or undefined when it can. Mirrors the ledger's checks so Send explains itself. */
export const inputProblem = (option: AttentionOption | undefined, value: InputValue | undefined) => {
  const spec = option?.input
  if (!spec) return
  if (!INPUT_KINDS.includes(spec.kind)) return "This choice needs input this app cannot collect. Answer it in a newer app or the source thread."
  if (spec.kind === "secret") return "Use Submit securely above; a secret is never sent with an answer"
  const empty = value === undefined || (typeof value === "string" ? !value.trim() : value.length === 0)
  if (empty) return spec.required ? `Add ${spec.label.toLowerCase()} to send` : undefined
  if (spec.kind === "text") return typeof value === "string" && value.length <= 2000 ? undefined : `${spec.label} must be at most 2000 characters`
  const ids = new Set(spec.choices?.map(choice => choice.id))
  const picked = typeof value === "string" ? [value] : value
  if (!picked.every(id => ids.has(id))) return `Pick ${spec.label.toLowerCase()} from the list`
  const max = spec.kind === "choice" ? 1 : spec.max ?? ids.size
  if (picked.length > max) return `Pick at most ${max}`
}

/** The `input_value` field for `option`, verbatim; omitted when nothing was supplied. */
export const inputPayload = (option: AttentionOption | undefined, value: InputValue | undefined) => {
  if (!option?.input || option.input.kind === "secret" || value === undefined) return {}
  if (typeof value === "string" ? !value.trim() : value.length === 0) return {}
  return { input_value: option.input.kind === "choice" && Array.isArray(value) ? value[0] : value }
}

/** A supplied value as the human reads it: choice labels, text verbatim. */
export const inputText = (option: AttentionOption | undefined, value: InputValue | undefined) => {
  if (value === undefined) return
  if (option?.input?.kind === "secret") return "Handed to the approved program · values not recorded"
  const labels = new Map(option?.input?.choices?.map(choice => [choice.id, choice.label]))
  return typeof value === "string" ? labels.get(value) ?? value : value.map(id => labels.get(id) ?? id).join(", ")
}

export type DeliveryState = "not-requested" | "pending" | "blocked" | "queued" | "admitted" | "presented" | "handled" | "closed"
export type AttentionList = {
  records: AttentionRecord[]
  projects: { editspace: string; available: boolean; error?: string }[]
  partial: boolean
  truncated?: boolean
}
export type AttentionAction = {
  action: "choose" | "answer" | "snooze" | "wake" | "resolve"
  choice_id?: string
  text?: string
  input_value?: InputValue
  brief?: { job: string; revision: string }
  snoozed_until?: number
  reason?: string
}

/** What a brief is prepared for: the request's content, not its status (older records fall back to revision). */
export const contentRevision = (record: AttentionRecord) => record.content_revision ?? record.revision

export const attentionPath = (path = "", editspace?: string) => `/es/api/attention${path}${editspace ? `?es=${encodeURIComponent(editspace)}` : ""}`

// Evidence wording follows runtime receipts only; status or idleness never advances it.
export const deliveryLabel = (record: AttentionRecord) => ({
  "not-requested": "Not sent",
  pending: "Saved · delivery not yet attempted",
  blocked: "Saved · delivery blocked",
  queued: "Saved · mail recorded, admission not confirmed",
  admitted: "Delivered to the agent's input queue · not yet read",
  presented: "Presented to agent · awaiting acknowledgement",
  handled: "Acknowledged by the agent",
  closed: "Not sent · record closed before delivery",
})[record.delivery_state] ?? `Delivery ${record.delivery_state}`

export const blockedReason = (reason: string | null | undefined) => ({
  "handoff-pending": "A handoff for this lane is in progress; delivery waits for it to complete.",
  "owner-unverified": "The lane's current owner is not on this request's verified handoff chain. Nothing was sent to it.",
  "no-owner": "The lane has no current agent owner.",
  "source-unverified": "The requesting session no longer exists in its published directory. Nothing was sent.",
  "source-unavailable": "The agent runtime is unreachable; delivery is retried automatically.",
  "source-superseded": "The requesting session was replaced. Nothing is forwarded to its replacement automatically.",
  "handoff-lineage-unavailable": "Handoff records are unreadable right now.",
  "no-actionable-recipient": "The lane's mail subscription is muted for this message.",
} as Record<string, string>)[reason ?? ""] ?? reason ?? ""

export const answerDraftKey = (record: AttentionRecord) => `es-attention-answer:${record.editspace}:${record.id}`
// An answer command whose outcome is unknown survives reload with its exact identity and payload.
const pendingPrefix = "es-attention-pending:"
type PendingCommand = { record: AttentionRecord; body: AttentionAction & { command_id: string; expected_revision: number } }
const pendingKey = (record: AttentionRecord) => `${pendingPrefix}${record.editspace}:${record.id}`
const storedPending = (): PendingCommand[] => Object.keys(localStorage).filter(key => key.startsWith(pendingPrefix)).sort().flatMap(key => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "")
    return value?.record?.id && value?.body?.command_id && value.body.action === "answer" ? [value as PendingCommand] : []
  } catch { return [] }
})

export const decisionLabel = (record: AttentionRecord) => {
  const choice = typeof record.decision === "string" ? record.decision : record.decision?.choice_id
  return record.options.find(option => option.id === choice)?.label ?? (typeof record.decision === "object" ? record.decision?.label : record.decision) ?? "Choice recorded"
}

// Own only the attention read/write interface; neither list nor act admits Session input.
/** `readOnly` observes the ledger only: no operator bootstrap and no resumed answer commands. `enabled` pauses reads. */
/** `deferOperator` leaves operator setup to `activate()`, so a shared reader does no setup writes until a page that answers needs them. */
export const createAttention = (project: () => string | undefined, options: { readOnly?: boolean; enabled?: () => boolean; deferOperator?: boolean } = {}) => {
  const [cache, setCache] = createSignal<Record<string, { records: AttentionRecord[]; project: AttentionList["projects"][number]; checked: number }>>({})
  const [scopes, setScopes] = createSignal<Record<string, { checked: number; partial: boolean; truncated: boolean }>>({})
  const snapshot = () => {
    const scope = project()
    const entries = scope ? cache()[scope] ? [cache()[scope]!] : [] : Object.values(cache())
    if (!entries.length && !scopes()[scope ?? ""]) return
    return {
      scope,
      checked: scopes()[scope ?? ""]?.checked ?? Math.min(...entries.map(item => item.checked)),
      value: {
        records: entries.flatMap(item => item.records).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)),
        projects: entries.map(item => item.project),
        partial: entries.some(item => !item.project.available) || (scopes()[scope ?? ""]?.partial ?? !scope),
        truncated: scopes()[scope ?? ""]?.truncated ?? false,
      },
    }
  }
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [operator, setOperator] = createSignal(false)
  const [pending, setPending] = createSignal<PendingCommand>()
  const [writing, setWriting] = createSignal(false)
  const [notice, setNotice] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  let version = 0
  let controller: AbortController | undefined
  const refresh = async () => {
    if (options.enabled && !options.enabled()) return
    const scope = project()
    const current = ++version
    controller?.abort()
    controller = new AbortController()
    setLoading(true)
    try {
      const pages: AttentionList[] = []
      for (let offset = 0; offset < 10_000; offset += 200) {
        const response = await fetch(`${attentionPath("", scope)}${scope ? "&" : "?"}view=all&limit=200&offset=${offset}`, { signal: controller.signal, credentials: "include" })
        if (!response.ok) throw new Error(response.status === 404 || response.status === 501 ? "Attention ledger is not installed. No decisions have been cleared." : `Attention ledger unavailable (HTTP ${response.status}).`)
        const page: AttentionList = await response.json()
        pages.push(page)
        if (!page.projects.some(item => page.records.filter(record => record.editspace === item.editspace).length === 200)) break
      }
      if (current !== version) return
      const projects = [...new Map(pages.flatMap(page => page.projects).map(item => [item.editspace, item])).values()]
      const unavailable = new Set(pages.flatMap(page => page.projects.filter(item => !item.available).map(item => item.editspace)))
      const checked = Date.now()
      setCache(previous => {
        const next = { ...previous }
        for (const item of projects) next[item.editspace] = {
          records: unavailable.has(item.editspace) ? previous[item.editspace]?.records ?? [] : [...new Map(pages.flatMap(page => page.records).filter(record => record.editspace === item.editspace).map(record => [record.id, record])).values()],
          project: { ...item, available: !unavailable.has(item.editspace) },
          checked: unavailable.has(item.editspace) ? previous[item.editspace]?.checked ?? 0 : checked,
        }
        if (!scope) for (const name of Object.keys(previous)) {
          if (!projects.some(item => item.editspace === name)) next[name] = { ...previous[name]!, project: { editspace: name, available: false, error: "Project no longer observed in registry" } }
        }
        return next
      })
      setScopes(previous => ({ ...previous, [scope ?? ""]: { checked, partial: unavailable.size > 0, truncated: pages.length === 50 } }))
      setError("")
      clearBackend("Attention ledger")
    } catch (cause) {
      if (current !== version) return
      // Source state keeps "unavailable"; its detail stays short and the header carries the status.
      setError(`Attention ledger unavailable (${describeFailure(cause)}).`)
      reportBackend("Attention ledger", cause)
    } finally {
      if (current === version) setLoading(false)
    }
  }
  const checkOperator = async () => {
    const response = await fetch(attentionPath("/session"), { credentials: "include" })
    // An operator cookie minted before written answers existed cannot send them; refresh it.
    if (response.ok) {
      const session = await response.json()
      if (session.operator === true && session.answer !== false) { setOperator(true); return }
    }
    const bootstrap = await fetch(attentionPath("/session"), { method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" })
    setOperator(bootstrap.ok && (await bootstrap.json()).operator === true)
  }
  const settle = (command: PendingCommand) => {
    if (command.body.action === "answer") localStorage.removeItem(pendingKey(command.record))
    setPending(undefined)
  }
  const resume = () => {
    const stored = storedPending()[0]
    if (!stored || pending()) return
    setPending(stored)
    setNotice("An answer sent before reload has an unknown outcome. Retrying repeats the same answer; no new answer is created.")
  }
  const activate = () => {
    resume()
    // Only explicitly allowlisted local UI origins can acquire the operator cookie.
    void checkOperator().catch(() => { setOperator(false) })
  }
  onMount(() => {
    if (options.readOnly) {
      const timer = setInterval(() => { setNow(Date.now()); void refresh() }, 30_000)
      onCleanup(() => { clearInterval(timer); version++; controller?.abort() })
      return
    }
    if (!options.deferOperator) activate()
    const timer = setInterval(() => { setNow(Date.now()); void refresh() }, 30_000)
    onCleanup(() => { clearInterval(timer); version++; controller?.abort() })
  })
  createEffect(() => { project(); options.enabled?.(); void refresh() })
  const retry = async () => {
    const command = pending()
    if (!command || writing()) return false
    setWriting(true)
    try {
      const send = () => fetch(attentionPath(`/${encodeURIComponent(command.record.id)}/commands`, command.record.editspace), {
        method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: JSON.stringify(command.body),
      })
      const first = await send()
      const response = first.status === 401
        ? await checkOperator().then(() => operator() ? send() : first)
        : first
      if (!response.ok) {
        if (response.status === 401) {
          setOperator(false)
          setNotice("Operator connection unavailable. Reconnect and retry the same answer; no local change was assumed.")
          return false
        }
        if (response.status >= 500) {
          setNotice(`Server response failed (HTTP ${response.status}). Outcome unknown; retry the same answer.`)
          return false
        }
        if (response.status === 403) setOperator(false)
        // The ledger's own reason names what is missing (e.g. a required input) so the human can fix and resend.
        const reason = response.status === 400 ? await response.json().then((body: { error?: unknown }) => typeof body.error === "string" ? body.error : undefined, () => undefined) : undefined
        setNotice(response.status === 409 ? "This record changed. Review the current revision before choosing again." : reason ? `Not sent: ${reason}.` : `Action refused (HTTP ${response.status}); no local change was assumed.`)
        settle(command)
        await refresh()
        resume()
        return false
      }
      settle(command)
      // Keep any newer draft typed while this older submission was in flight.
      if (command.body.action === "answer" && localStorage.getItem(answerDraftKey(command.record)) === command.body.text) localStorage.removeItem(answerDraftKey(command.record))
      setNotice(command.body.action === "choose" ? "Decision saved · not sent."
        : command.body.action === "answer" ? "Answer saved. It is delivered only to the verified current owner of this request; evidence appears under Answered."
        : "Saved to the attention ledger.")
      await refresh()
      resume()
      return true
    } catch {
      setNotice("Response lost. Outcome unknown; retry the same answer or refresh before proceeding.")
      return false
    } finally { setWriting(false) }
  }
  const act = (record: AttentionRecord, action: AttentionAction) => {
    if (pending() || writing()) return Promise.resolve(false)
    const command = { record, body: { ...action, expected_revision: record.revision, command_id: crypto.randomUUID() } }
    if (action.action === "answer") {
      // Persist before POST so a lost response can be retried with this identity after reload.
      try { localStorage.setItem(pendingKey(record), JSON.stringify(command)) } catch {
        setNotice("Could not save this answer's identity locally, so it was not sent. Free browser storage and try again.")
        return Promise.resolve(false)
      }
    }
    setPending(command)
    return retry()
  }
  // Re-evaluates delivery now; no new answer or revision, so it is safe to repeat.
  const retryDelivery = async (record: AttentionRecord) => {
    if (writing()) return
    setWriting(true)
    try {
      const response = await fetch(attentionPath(`/${encodeURIComponent(record.id)}/delivery`, record.editspace), {
        method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}",
      })
      setNotice(response.ok ? "Delivery re-checked." : `Delivery check refused (HTTP ${response.status}). The answer remains saved.`)
    } catch {
      setNotice("Delivery check response lost. The answer remains saved; check again.")
    } finally {
      setWriting(false)
      await refresh()
    }
  }
  return {
    retryDelivery,
    snapshot,
    error, loading, operator, pending, writing, notice, now, refresh, checkOperator, activate, act, retry,
    stale: () => !snapshot() || !!error() || now() - snapshot()!.checked > 45_000,
  }
}

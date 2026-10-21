/* Failed-turn tracking. Core's /experimental/session/failed is the durable source:
 * a root Session whose newest message is an assistant step that ended in a
 * non-abort error. Live status events only hide a failure while newer work runs
 * and schedule a re-read; they never invent one. */
import { createSignal } from "solid-js"
import type { Event, SessionFailure } from "@opencode-ai/sdk/v2"
import { oc } from "./api"
import { unresolvedSend } from "./composer"

export type RetryResult = Awaited<ReturnType<typeof oc.retrySession>> | { outcome: "blocked"; detail: string }
export type RetryState =
  | { phase: "sending"; messageID: string }
  | { phase: "done"; messageID: string; result: RetryResult }

const STATUS_TEXT: Record<number, string> = {
  400: "bad request", 401: "unauthorized", 402: "payment required", 403: "forbidden", 404: "not found",
  408: "timeout", 413: "request too large", 429: "rate limited", 500: "server error", 502: "bad gateway",
  503: "unavailable", 504: "gateway timeout", 529: "overloaded",
}

// Built from the error name and status only: provider messages can echo credentials or request bodies.
export const failureLabel = (failure: Pick<SessionFailure, "error">) => {
  const code = failure.error.statusCode
  if (failure.error.name === "APIError")
    return code ? `Provider error ${code}${STATUS_TEXT[code] ? ` (${STATUS_TEXT[code]})` : ""}` : "Provider error"
  if (failure.error.name === "ProviderAuthError") return "Provider authentication failed"
  if (failure.error.name === "ContentFilterError") return "Blocked by the provider's content filter"
  if (failure.error.name === "ContextOverflowError") return "Context window exceeded"
  if (failure.error.name === "MessageOutputLengthError") return "Output length limit reached"
  if (failure.error.name === "StructuredOutputError") return "No structured output produced"
  return "Turn failed"
}

export const unavailableReason = (failure: Pick<SessionFailure, "retry">) =>
  failure.retry === "out-of-order" ? "the failed step is timestamped in the future" : "the failed step ran tools"

export const retryLabel = (result: RetryResult) => {
  switch (result.outcome) {
    case "accepted": return "Retry started"
    case "running": return "Already running"
    case "stale": return result.failed ? "Failed again since this retry was offered" : "Already continued"
    case "not-failed": return "No longer failed"
    case "unsafe": return `Not retried: ${result.failed ? unavailableReason(result.failed) : "the failed step ran tools"}`
    case "waiting": return "Waiting for a permission or question reply"
    case "archived": return "Archived"
    case "child": return "Subagent session; retry its parent"
    case "superseded": return "Handed off; continue in the successor"
    case "mismatch": return "Directory mismatch; not retried"
    case "unknown": return `Outcome unknown (${result.detail}); still shown as failed until confirmed`
    case "unavailable": return "Retry unavailable on this server"
    case "rejected": return `Not retried (${result.detail})`
    case "blocked": return `Not retried: ${result.detail}`
  }
}

export const createSessionFailures = (deps: {
  list?: () => Promise<SessionFailure[] | undefined>
  send?: (failure: SessionFailure) => Promise<RetryResult>
  blocked?: (failure: SessionFailure) => string
} = {}) => {
  const blocked = deps.blocked ?? ((failure: SessionFailure) => unresolvedSend(failure.sessionID, failure.directory))
  const list = deps.list ?? oc.failedSessions
  const send = deps.send ?? oc.retrySession
  const [items, setItems] = createSignal<SessionFailure[]>([])
  const [supported, setSupported] = createSignal<boolean>()
  const [error, setError] = createSignal("")
  // Time of the last successful read, so consumers can disclose freshness.
  const [checked, setChecked] = createSignal<number>()
  // sessionID -> failed messageID that newer local evidence (busy, accepted retry) supersedes
  const [hidden, setHidden] = createSignal<Record<string, string>>({})
  const [retries, setRetries] = createSignal<Record<string, RetryState>>({})
  const versions = new Map<string, number>()
  // Sessions last seen running. Suppression outlives a same-identity read only while running:
  // a retry can go idle again before writing any newer row (config, model or title errors).
  const active = new Set<string>()
  const settled = new Map<string, number>()
  let revision = 0
  let inflight: Promise<void> | undefined
  let again = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const touch = (id: string) => versions.set(id, ++revision)
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (inflight) {
      again = true
      return inflight
    }
    const start = revision
    inflight = (async () => {
      try {
        const next = await list()
        if (disposed) return
        if (!next) {
          setSupported(false)
          setItems([])
          return
        }
        setSupported(true)
        setError("")
        setChecked(Date.now())
        // A session with events after this read began keeps its previous entry until the next read.
        const raced = (id: string) => (versions.get(id) ?? 0) > start
        setItems((previous) => [
          ...next.filter((item) => !raced(item.sessionID)),
          ...previous.filter((item) => raced(item.sessionID)),
        ])
        setHidden((previous) => Object.fromEntries(Object.entries(previous).filter(([id, messageID]) =>
          raced(id) || (active.has(id) && next.some((item) => item.sessionID === id && item.messageID === messageID)))))
      } catch {
        if (!disposed)
          setError(`Failed-session status unavailable${items().length ? "; last-known failures retained" : ""}.`)
      }
    })().finally(() => {
      inflight = undefined
      if (again) {
        again = false
        void refresh()
      }
    })
    return inflight
  }
  const schedule = () => {
    if (timer || disposed) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, 400)
  }
  const observe = (event: Event) => {
    if (event.type !== "session.status" && event.type !== "session.error" && event.type !== "session.idle") return
    const id = event.properties.sessionID
    if (!id) return
    const status = event.type === "session.status" ? event.properties.status.type : undefined
    if (status === "busy" || status === "retry") {
      active.add(id)
      const current = items().find((item) => item.sessionID === id)
      if (!current) return
      touch(id)
      setHidden((previous) => ({ ...previous, [id]: current.messageID }))
      return
    }
    if (event.type === "session.error" || event.type === "session.idle" || status === "idle") {
      active.delete(id)
      touch(id)
      settled.set(id, revision)
      schedule()
    }
  }
  const failure = (id: string) => items().find((item) => item.sessionID === id && hidden()[id] !== item.messageID)
  const retry = async (target: SessionFailure): Promise<RetryResult | undefined> => {
    const current = retries()[target.sessionID]
    // One request per failure identity at a time; Core still decides exactly-once.
    if (current?.phase === "sending") return
    const reason = blocked(target)
    if (reason) {
      const result = { outcome: "blocked" as const, detail: reason }
      setRetries((previous) => ({ ...previous, [target.sessionID]: { phase: "done", messageID: target.messageID, result } }))
      return result
    }
    setRetries((previous) => ({ ...previous, [target.sessionID]: { phase: "sending", messageID: target.messageID } }))
    const started = revision
    const result = await send(target)
    touch(target.sessionID)
    if (result.outcome === "accepted" || result.outcome === "running") {
      // The run may already have gone idle while the response was in flight.
      if ((settled.get(target.sessionID) ?? 0) <= started) active.add(target.sessionID)
      setHidden((previous) => ({ ...previous, [target.sessionID]: target.messageID }))
    }
    setRetries((previous) => ({ ...previous, [target.sessionID]: { phase: "done", messageID: target.messageID, result } }))
    schedule()
    return result
  }
  const retryAll = async (targets: SessionFailure[], concurrency = 3) => {
    const queue = targets.filter((item) => item.retry === "available" && retries()[item.sessionID]?.phase !== "sending")
    const results: { failure: SessionFailure; result: RetryResult | undefined }[] = []
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) results.push({ failure: next, result: await retry(next) })
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    return results
  }
  const retryState = (id: string) => {
    const state = retries()[id]
    const current = items().find((item) => item.sessionID === id)
    // A result describes one failure identity; a newer failure starts clean.
    return state && (!current || state.messageID === current.messageID || state.phase === "sending") ? state : undefined
  }
  const dispose = () => {
    disposed = true
    clearTimeout(timer)
  }
  return { items, failure, supported, error, checked, refresh, schedule, observe, retry, retryAll, retryState, dispose }
}

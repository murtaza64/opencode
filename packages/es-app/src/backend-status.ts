/* One app-wide account of background reads that are failing. Pages keep their
 * last-known content and report here instead of rendering their own warning;
 * the header shows a single compact indicator once trouble persists, with the
 * sanitized detail behind a disclosure. Human-actionable results of a user's
 * own action (an unconfirmed send or ignore) stay where the action happened. */
import { createRoot, createSignal } from "solid-js"

export type BackendIssue = {
  source: string
  detail: string
  /** Transient: load or availability (5xx, timeout, offline). Otherwise a real fault worth fixing. */
  transient: boolean
  since: number
}

/** How long a background failure must persist before the indicator reports it. */
export const BACKEND_STATUS_DELAY_MS = 2000

const store = createRoot(() => {
  const [issues, setIssues] = createSignal<Record<string, BackendIssue>>({})
  const [shown, setShown] = createSignal<"" | "updating" | "problem">("")
  let timer: ReturnType<typeof setTimeout> | undefined
  const evaluate = () => {
    const current = Object.values(issues())
    if (!current.length) {
      clearTimeout(timer)
      timer = undefined
      return setShown("")
    }
    const kind = current.some((issue) => !issue.transient) ? "problem" : "updating"
    const due = Math.min(...current.map((issue) => issue.since)) + BACKEND_STATUS_DELAY_MS - Date.now()
    clearTimeout(timer)
    if (due <= 0) return setShown(kind)
    timer = setTimeout(evaluate, due)
  }
  return { issues, setIssues, shown, evaluate }
})

export const backendIssues = () => Object.values(store.issues()).sort((a, b) => a.since - b.since)
export const backendStatus = store.shown

export const reportBackend = (source: string, cause: unknown) => {
  const detail = describeFailure(cause)
  const transient = isTransient(cause)
  const previous = store.issues()[source]
  if (previous && previous.detail === detail && previous.transient === transient) return
  // Agents read the console; keep one sanitized line per change, never raw bodies or URLs.
  console.info(`[backend] ${source}: ${detail}`)
  store.setIssues((current) => ({ ...current, [source]: { source, detail, transient, since: previous?.since ?? Date.now() } }))
  store.evaluate()
}

export const clearBackend = (source: string) => {
  if (!store.issues()[source]) return
  console.info(`[backend] ${source}: recovered`)
  store.setIssues((current) => {
    const next = { ...current }
    delete next[source]
    return next
  })
  store.evaluate()
}

/** Test seam. */
export const resetBackend = () => {
  store.setIssues({})
  store.evaluate()
}

const statusOf = (cause: unknown): number | undefined => {
  if (cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number") return cause.status
  const match = /\bHTTP (\d{3})\b/.exec(String(cause instanceof Error ? cause.message : cause))
  return match ? Number(match[1]) : undefined
}

export const isTransient = (cause: unknown) => {
  const status = statusOf(cause)
  // 501: the server has no such route; that is a missing feature, not load.
  if (status !== undefined) return (status >= 500 && status !== 501) || status === 408 || status === 429
  // No status: the request never got an answer (offline, refused, timed out, aborted).
  return true
}

/** A short human phrase: no URLs, paths, JSON or stack text. */
export const describeFailure = (cause: unknown) => {
  const status = statusOf(cause)
  if (status === 401 || status === 403) return `not authorized (HTTP ${status})`
  if (status === 404 || status === 501) return `not available here (HTTP ${status})`
  if (status === 502 || status === 503 || status === 504) return `service unavailable (HTTP ${status})`
  if (status !== undefined) return `HTTP ${status}`
  const text = String(cause instanceof Error ? `${cause.name} ${cause.message}` : cause)
  if (/timeout|timed out/i.test(text)) return "timed out"
  if (/abort/i.test(text)) return "cancelled"
  return "no connection"
}

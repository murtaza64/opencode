/* Ignored failures: the dashboard's ignored-failures file, shared by every client. An ignore hides
 * one exact failure (session + failed message) from the Front desk queue. It is not a resolution
 * or a retry and never touches the session; a newer failure in that session shows again. */
import { createSignal } from "solid-js"
import type { SessionFailure } from "@opencode-ai/sdk/v2"

export type IgnoredFailure = {
  sessionID: string
  messageID: string
  directory: string
  failedAt: number | null
  label: string
  ignoredAt: number
}

const IGNORES_URL = "/es/api/frontdesk/ignored-failures"
// The last list the dashboard confirmed. A failed read keeps using it, so an outage never un-ignores.
const CACHE_KEY = "es-app:failure-ignores:confirmed:1"
const cached = (storage: () => Pick<Storage, "getItem" | "setItem"> | undefined) => {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(CACHE_KEY) ?? "null")
    return Array.isArray(value) ? value as IgnoredFailure[] : undefined
  } catch {
    return undefined
  }
}
const key = (item: Pick<SessionFailure, "sessionID" | "messageID">) => `${item.sessionID}\n${item.messageID}`

export const createFailureIgnores = (deps: { fetch?: typeof fetch; storage?: () => Pick<Storage, "getItem" | "setItem"> | undefined } = {}) => {
  const request = deps.fetch ?? ((input, init) => fetch(input, init))
  const storage = deps.storage ?? (() => { try { return localStorage } catch { return undefined } })
  const initial = cached(storage)
  const [entries, setEntries] = createSignal<IgnoredFailure[]>(initial ?? [])
  // Nothing is hidden until a list is known: confirmed on an earlier read, or read now.
  const [loaded, setLoaded] = createSignal(initial !== undefined)
  const [pending, setPending] = createSignal<Record<string, boolean>>({})
  const [notice, setNotice] = createSignal("")
  // A failed read changes nothing the person must act on (all failures stay listed): shown quietly,
  // with the cause kept for diagnostics. Failed writes stay ordinary notices.
  const [quiet, setQuiet] = createSignal<string>()
  const accept = async (response: Response) => {
    const body = await response.json() as { entries?: IgnoredFailure[] }
    const next = Array.isArray(body.entries) ? body.entries : []
    setEntries(next)
    setLoaded(true)
    try { storage()?.setItem(CACHE_KEY, JSON.stringify(next)) } catch { /* the in-page list still applies */ }
  }
  const load = async () => {
    try {
      const response = await request(IGNORES_URL, { credentials: "include" })
      if (!response.ok) throw new Error(response.status === 404 ? "the dashboard has no ignored-failures endpoint" : `HTTP ${response.status}`)
      await accept(response)
      setNotice("")
      setQuiet()
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      setNotice(loaded() ? "Ignored failures could not be refreshed; the last confirmed list still applies." : "Ignored failures unavailable; all failures are shown.")
      setQuiet(reason)
    }
  }
  const change = async (op: "ignore" | "unignore", item: Pick<SessionFailure, "sessionID" | "messageID" | "directory"> & { failedAt?: number; label?: string }) => {
    const id = key(item)
    if (pending()[id]) return
    setPending(previous => ({ ...previous, [id]: true }))
    try {
      const response = await request(IGNORES_URL, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "X-Attention-CSRF": "1" },
        body: JSON.stringify({ op, sessionID: item.sessionID, messageID: item.messageID, directory: item.directory, failedAt: item.failedAt, label: item.label }),
      }).catch(() => undefined)
      if (response?.ok) {
        await accept(response)
        setNotice("")
        setQuiet()
        return
      }
      // Both ops are idempotent; re-read so the list shows whatever actually committed.
      await load()
      const reason = !response ? "no response" : response.status === 401 || response.status === 403 ? "the operator connection is unavailable" : `HTTP ${response.status}`
      setNotice(`${op === "ignore" ? "Ignore" : "Unignore"} not confirmed (${reason}).`)
      setQuiet()
    } finally {
      setPending(previous => { const next = { ...previous }; delete next[id]; return next })
    }
  }
  const ignored = (item: Pick<SessionFailure, "sessionID" | "messageID">) => loaded() && entries().some(entry => key(entry) === key(item))
  return {
    entries, loaded, notice, quiet, load, ignored,
    busy: (item: Pick<SessionFailure, "sessionID" | "messageID">) => !!pending()[key(item)],
    ignore: (failure: SessionFailure, label: string) => change("ignore", { ...failure, failedAt: failure.time || undefined, label }),
    unignore: (entry: IgnoredFailure) => change("unignore", { sessionID: entry.sessionID, messageID: entry.messageID, directory: entry.directory }),
  }
}

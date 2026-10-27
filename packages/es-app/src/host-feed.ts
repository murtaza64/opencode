/* Another execution host's sessions in this page's Work view. Reads go through the laptop
 * listener's host-qualified routes (/hosts/<id>/...), which send no credential or cookie; opening,
 * writing and drafting stay on that host's own listener origin. One list read on load, then only
 * that host's session events (coalesced to one list read per 5 s), and one read on reconnect. */
import { createSignal, onCleanup } from "solid-js"
import type { GlobalSession } from "@opencode-ai/sdk/v2"
import { coalesced } from "./coalesced"
import { createServerEvents } from "./event-source"
import type { WorkHost } from "./host"

/** A session row; `host` names a Work view host other than this page's, undefined for this page's. */
export type HostedRow = {
  id: string
  title: string
  directory: string
  updated: number
  live?: string
  project?: string
  archived?: number
  host?: string
}

export type HostFeedState = {
  status: "loading" | "ready" | "unavailable"
  /** Last-known rows; kept, marked unavailable, when the host stops answering. */
  rows: HostedRow[]
  /** When the host was first seen unavailable in the current outage. */
  since?: number
  /** Whether `rows` were narrowed to the selected project (false: that host has no such project). */
  scoped: boolean
}

/** Key of a row across hosts: this page's rows keep their plain session ID (existing pins, drafts and
 * receipts keep working); another host's are `<host>:<session>`, so equal IDs never collide. */
export const hostRowKey = (row: { id: string; host?: string }) => row.host ? `${row.host}:${row.id}` : row.id

/** Another host's root, unarchived sessions as rows, narrowed to one of its projects when given. */
export const hostRows = (host: string, sessions: GlobalSession[], root?: string) => {
  const base = root?.replace(/\/+$/, "").replace(/\/\.editspace$/, "")
  return sessions
    .filter((session) => !session.parentID && !session.time.archived)
    .filter((session) => base === undefined || session.directory === base || session.directory.startsWith(`${base}/`))
    .map((session): HostedRow => ({ id: session.id, title: session.title, directory: session.directory, updated: session.time.updated, host }))
}

/** One list across hosts, newest first; each row stays distinct by its host-qualified key. */
export const workRows = (...lists: HostedRow[][]) => {
  const rows = new Map<string, HostedRow>()
  for (const row of lists.flat()) rows.set(hostRowKey(row), row)
  return [...rows.values()].sort((a, b) => b.updated - a.updated)
}

/** The opening URL of another host's session: its own listener's session route. */
export const hostSessionHref = (host: WorkHost, row: Pick<HostedRow, "id" | "directory">) =>
  `${host.origin}/session/${encodeURIComponent(row.id)}?directory=${encodeURIComponent(row.directory)}`

const LIST_MS = 5000
const SESSION_EVENTS = ["session.created", "session.updated", "session.deleted", "session.status"]

/** `project`: the selected project name, undefined for all projects, null while not yet known. */
export const createHostFeed = (host: WorkHost, project: () => string | undefined | null) => {
  const base = `/hosts/${host.id}`
  const [state, setState] = createSignal<HostFeedState>({ status: "loading", rows: [], scoped: false })
  const [live, setLive] = createSignal<Record<string, string>>({})
  let loading: Promise<void> | undefined
  const read = async <T,>(path: string) => {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel()
      throw new Error(`${host.label}: HTTP ${response.status}`)
    }
    return (await response.json()) as T
  }
  const run = async () => {
    const name = project()
    if (name === null) return
    try {
      const [sessions, editspaces] = await Promise.all([
        read<GlobalSession[]>("/oc/experimental/session?roots=true&archived=false&limit=200"),
        name ? read<{ editspaces: { name: string; root: string }[] }>("/es/api/editspaces") : undefined,
      ])
      if (!Array.isArray(sessions)) throw new Error(`${host.label}: invalid session list`)
      const root = name ? editspaces?.editspaces?.find((item) => item.name === name)?.root : undefined
      setState({ status: "ready", rows: name && !root ? [] : hostRows(host.id, sessions, root), scoped: !!root })
    } catch {
      setState((previous) => ({ ...previous, status: "unavailable", since: previous.since ?? Date.now() }))
    }
  }
  // Single-flight; a project change during a read reads again for the new project.
  const load = (): Promise<void> => (loading ??= (async () => {
    const name = project()
    await run()
    loading = undefined
    if (project() !== name) await load()
  })())
  const changed = coalesced(() => void load(), LIST_MS)
  const source = createServerEvents(`${base}/oc/global/event`, { types: SESSION_EVENTS })
  let dropped = false
  source.onerror = () => (dropped = true)
  source.onopen = () => {
    if (!dropped) return
    dropped = false
    void load()
  }
  source.onmessage = (message) => {
    const event = (() => {
      try { return JSON.parse(message.data)?.payload as { type?: string; properties?: Record<string, any> } | undefined } catch { return undefined }
    })()
    if (event?.type === "session.status" && typeof event.properties?.sessionID === "string") {
      const id = event.properties.sessionID
      const type = typeof event.properties.status?.type === "string" ? event.properties.status.type : "idle"
      setLive((previous) => previous[id] === type ? previous : { ...previous, [id]: type })
      return
    }
    changed()
  }
  onCleanup(() => {
    source.close()
    changed.cancel()
  })
  void load()
  return {
    host,
    state,
    /** Live status from that host's events since load ("busy", "retry", "idle"); undefined if unseen. */
    live: (id: string) => live()[id],
    /** Reload this host's list now (project change, retry). */
    load,
  }
}

export type HostFeed = ReturnType<typeof createHostFeed>

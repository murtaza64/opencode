/* Another execution host's sessions in this page's Work view. Reads go through the laptop
 * listener's host-qualified routes (/hosts/<id>/...), which send no credential or cookie; opening,
 * writing and drafting stay on that host's own listener origin. One list read on load, then only
 * that host's session events (coalesced to one list read per 5 s), and one read on reconnect. */
import { createSignal, onCleanup } from "solid-js"
import type { GlobalSession } from "@opencode-ai/sdk/v2"
import { coalesced } from "./coalesced"
import { createServerEvents } from "./event-source"
import type { WorkHost } from "./host"
import type { AttentionList, AttentionRecord } from "./attention"
import { loadSeen, saveSeen } from "./last-seen"
import type { Handoff, LaneOwner } from "./handoffs"

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

/** Why a host is unavailable: sign-in needed (401/403/sign-in redirect) is shown apart from unreachable. */
export type ReachReason = "network" | "auth" | "server"

export type HostFeedState = {
  status: "loading" | "ready" | "unavailable"
  /** Set while unavailable. */
  reason?: ReachReason
  /** Last read attempt (success or failure). */
  checkedAt?: number
  /** Set while `rows` are a previous page load's last-seen rows, not yet confirmed by a read. */
  cachedAt?: number
  /** Last-known rows; kept, marked unavailable, when the host stops answering. */
  rows: HostedRow[]
  /** When the host was first seen unavailable in the current outage. */
  since?: number
  /** Whether `rows` were narrowed to the selected project (false: that host has no such project). */
  scoped: boolean
  /** That host's open decisions (same project scope as `rows`); last-known while unavailable. */
  decisions: AttentionRecord[]
  /** The decision list could not be read on the last attempt, so `decisions` may be out of date. */
  decisionsStale?: boolean
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

/** The opening URL of another host's decision: its own listener's Front desk, with the record selected,
 * so it is answered there with that host's operator session. */
export const hostDecisionHref = (host: WorkHost, record: Pick<AttentionRecord, "editspace" | "id">) =>
  `${host.origin}/desk?item=${encodeURIComponent(`attention:${record.editspace}:${record.id}`)}`

/** The opening URL of another host's session: read-only in this window (Slice R); replying happens on
 * that host's own tab (`hostTabHref`). */
export const hostSessionHref = (host: WorkHost, row: Pick<HostedRow, "id" | "directory">) =>
  `/session/${encodeURIComponent(row.id)}?directory=${encodeURIComponent(row.directory)}&host=${encodeURIComponent(host.id)}`

/** The same session on that host's own tab (its listener origin, auth, drafts and receipts). */
export const hostTabHref = (host: WorkHost, row: Pick<HostedRow, "id" | "directory">) =>
  `${host.origin}/session/${encodeURIComponent(row.id)}?directory=${encodeURIComponent(row.directory)}`

class ReachError extends Error {
  constructor(readonly reason: ReachReason, message: string) {
    super(message)
  }
}

/** The reason a failed response gives: 401/403 and a redirect (to a sign-in page) need sign-in; any other status is the server. */
export const reasonFor = (status: number): ReachReason => (status === 401 || status === 403 || (status >= 300 && status < 400) ? "auth" : "server")

/** The registry reach of a host feed (contract v0.2.1 §2). */
export const reachOf = (state: HostFeedState) => ({
  state: state.status === "ready" ? "reachable" as const : state.status === "unavailable" ? "unreachable" as const : "unknown" as const,
  ...(state.status === "unavailable" ? { reason: state.reason ?? "network", since: state.since } : {}),
  ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
  ...(state.cachedAt ? { cachedAt: state.cachedAt } : {}),
})

const LIST_MS = 5000
const DECISIONS_MS = 30_000
const LINEAGE_MS = 60_000
const SESSION_EVENTS = ["session.created", "session.updated", "session.deleted", "session.status"]

/** `project`: the selected project name, undefined for all projects, null while not yet known. */
export const createHostFeed = (host: WorkHost, project: () => string | undefined | null) => {
  const base = `/hosts/${host.id}`
  // Until the first read answers, show what this host last listed (if the project matches), marked by its age.
  const seen = (() => {
    const name = project()
    return name === null ? undefined : loadSeen(host.id, name)
  })()
  const [state, setState] = createSignal<HostFeedState>({
    status: "loading",
    rows: seen ? seen.rows.map((row) => ({ ...row, host: host.id })) : [],
    scoped: false,
    decisions: [],
    ...(seen ? { cachedAt: seen.cachedAt } : {}),
  })
  const [live, setLive] = createSignal<Record<string, string>>({})
  const [lineage, setLineage] = createSignal<{ project: string; edges: Handoff[]; owners: LaneOwner[] }>()
  let lastLineageRead = 0
  let lineageRead: Promise<void> | undefined
  let loading: Promise<void> | undefined
  const read = async <T,>(path: string) => {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel()
      throw new ReachError(reasonFor(response.status), `${host.label}: HTTP ${response.status}`)
    }
    return (await response.json()) as T
  }
  // The decision scope of the last list read: the project name, and that host's editspace for it
  // (`none`: that host has no such project). Undefined until the first list read.
  let scope: { project: string | undefined; es?: string; none?: boolean } | undefined
  const readDecisions = async () => {
    const current = scope
    if (!current) return undefined
    if (current.none) return []
    return read<AttentionList>(`/es/api/attention?view=open&limit=200${current.es ? `&es=${encodeURIComponent(current.es)}` : ""}`)
      .then((list) => Array.isArray(list.records) ? list.records.filter((record) => record.status === "open") : undefined)
      .catch(() => undefined)
  }
  const refreshLineage = () => {
    const current = scope
    const es = current?.es
    if (!es || state().status !== "ready" || lineageRead || Date.now() - lastLineageRead < LINEAGE_MS) return
    lastLineageRead = Date.now()
    setLineage(undefined)
    lineageRead = (async () => {
      try {
        const [handoffs, dashboard] = await Promise.all([
          read<{ handoffs: Handoff[] }>(`/es/api/handoffs?es=${encodeURIComponent(es)}`),
          read<{ editspace: string; threads: { lanes?: { lane: string; owner?: string }[] }[] }>(`/es/api/state?es=${encodeURIComponent(es)}`),
        ])
        if (dashboard.editspace !== es || !Array.isArray(handoffs.handoffs) || !Array.isArray(dashboard.threads)) throw new Error("Invalid host lineage")
        if (scope?.es !== es || state().status !== "ready") return
        setLineage({
          project: es,
          edges: handoffs.handoffs,
          owners: dashboard.threads.flatMap((thread) => (thread.lanes ?? []).flatMap((lane): LaneOwner[] =>
            lane.owner ? [{ lane: lane.lane, owner: lane.owner }] : [])),
        })
      } catch {
        if (scope?.es === es) setLineage(undefined)
      }
    })().finally(() => {
      lineageRead = undefined
      if (scope?.es !== es) refreshLineage()
    })
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
      const same = scope?.project === name
      scope = { project: name, ...(root ? { es: name } : {}), ...(name && !root ? { none: true } : {}) }
      if (!same) {
        setLineage(undefined)
        lastLineageRead = 0
      }
      // A decision list that fails to read keeps the last one for this project, marked stale.
      const decisions = await readDecisions()
      const rows = name && !root ? [] : hostRows(host.id, sessions, root)
      saveSeen(host.id, rows, name)
      setState((previous) => ({
        checkedAt: Date.now(),
        status: "ready",
        rows,
        scoped: !!root,
        decisions: decisions ?? (same ? previous.decisions : []),
        decisionsStale: !decisions,
      }))
      refreshLineage()
    } catch (error) {
      setLineage(undefined)
      const reason = error instanceof ReachError ? error.reason : "network"
      // Nothing listed yet in this page (the host was down at load): show its last-seen rows for this project.
      const fallback = !state().rows.length && !state().checkedAt ? loadSeen(host.id, name) : undefined
      setState((previous) => ({
        ...previous,
        ...(fallback ? { rows: fallback.rows.map((row) => ({ ...row, host: host.id })), cachedAt: fallback.cachedAt } : {}),
        status: "unavailable", reason, checkedAt: Date.now(), since: previous.since ?? Date.now(),
      }))
    }
  }
  // Decisions have no event on the session stream: between list reads, read only the decision list.
  const refreshDecisions = async () => {
    refreshLineage()
    const current = scope
    if (loading || state().status !== "ready" || document.visibilityState !== "visible") return
    const decisions = await readDecisions()
    if (scope !== current) return
    setState((previous) => ({ ...previous, decisions: decisions ?? previous.decisions, decisionsStale: !decisions }))
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
  const timer = setInterval(() => void refreshDecisions(), DECISIONS_MS)
  onCleanup(() => {
    source.close()
    changed.cancel()
    clearInterval(timer)
  })
  void load()
  return {
    host,
    state,
    lineage,
    /** Live status from that host's events since load ("busy", "retry", "idle"); undefined if unseen. */
    live: (id: string) => live()[id],
    /** Reload this host's list now (project change, retry). */
    load,
  }
}

export type HostFeed = ReturnType<typeof createHostFeed>

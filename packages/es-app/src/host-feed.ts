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
import type { HomeRequestRow } from "./home-requests"
import type { NeedsYouInputs } from "./needs-you"
import type { Surface } from "./surfaces"

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
  pinnedAt?: number
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
  /** That host's pending permission and question pointers (its own dashboard's list; same project scope); last-known
   * while unavailable. The detail validates one against that host's Core before answering. */
  requests: HomeRequestRow[]
  /** The request list could not be read on the last attempt, or that host's dashboard does not serve it. */
  requestsStale?: boolean
  /** That host's Surfaces (boards and deliverables, same project scope); last-known while unavailable. */
  surfaces: Surface[]
  /** The Surface list could not be read on the last attempt. */
  surfacesStale?: boolean
  /** That host's dashboard serves no Surfaces (404/501): a plain fact, not an outage. */
  surfacesUnsupported?: boolean
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

/** @deprecated The native-flip opening of another host's decision (its own listener's Front desk); being replaced by
 * the in-Work `WorkEntry.href` (Main1555). */
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
export const reachOf = (state: Pick<HostFeedState, "status" | "reason" | "since" | "checkedAt" | "cachedAt">) => ({
  state: state.status === "ready" ? "reachable" as const : state.status === "unavailable" ? "unreachable" as const : "unknown" as const,
  ...(state.status === "unavailable" ? { reason: state.reason ?? "network", since: state.since } : {}),
  ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
  ...(state.cachedAt ? { cachedAt: state.cachedAt } : {}),
})

const LIST_MS = 5000
const DECISIONS_MS = 30_000
const LINEAGE_MS = 60_000
const SESSION_EVENTS = ["session.created", "session.updated", "session.deleted", "session.status"]

/** That host's handoff lineage, per editspace (lane names repeat across editspaces), and which editspace holds a
 * directory. `project`: the selected project, or "*" for All projects. */
export type HostLineage = { project: string; byEditspace: Record<string, { edges: Handoff[]; owners: LaneOwner[] }>; editspaceOf: (directory: string) => string | undefined }

const MAX_LINEAGE_EDITSPACES = 4

/** `project`: the selected project name, undefined for all projects, null while not yet known. `pinned`: directories of
 * this host's pinned sessions; in All projects, lineage is read only for the editspaces that hold them. */
export const createHostFeed = (host: WorkHost, project: () => string | undefined | null, pinned: () => string[] = () => []) => {
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
    requests: [],
    surfaces: [],
    ...(seen ? { cachedAt: seen.cachedAt } : {}),
  })
  const [live, setLive] = createSignal<Record<string, string>>({})
  const [lineage, setLineage] = createSignal<HostLineage>()
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
  // One read of that host's open decisions with its pending requests (needs-you inputs); undefined parts failed or are
  // not served by that dashboard, and keep their last-known rows marked stale.
  const readNeeds = async (): Promise<{ decisions?: AttentionRecord[]; requests?: HomeRequestRow[] }> => {
    const current = scope
    if (!current) return {}
    if (current.none) return { decisions: [], requests: [] }
    const body = await read<NeedsYouInputs>(`/es/api/attention?view=open&limit=200&include=needs-you-inputs${current.es ? `&es=${encodeURIComponent(current.es)}` : ""}`)
      .catch(() => undefined)
    const requests = body?.inputs?.sources?.requests?.ok && Array.isArray(body.inputs.requests) ? body.inputs.requests : undefined
    return {
      decisions: body && Array.isArray(body.records) ? body.records.filter((record) => record.status === "open") : undefined,
      requests: requests?.filter((request) => current.project === undefined || request.project === current.project),
    }
  }
  type SurfaceRead = { surfaces: Surface[] } | { unsupported: true } | undefined
  const readSurfaces = async (): Promise<SurfaceRead> => {
    const current = scope
    if (!current) return undefined
    if (current.none) return { surfaces: [] }
    const response = await fetch(`${base}/es/api/surfaces`, { signal: AbortSignal.timeout(15_000), cache: "no-store" }).catch(() => undefined)
    if (response && (response.status === 404 || response.status === 501)) {
      await response.body?.cancel()
      return { unsupported: true }
    }
    if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response?.body?.cancel()
      return undefined
    }
    const body = (await response.json().catch(() => undefined)) as { surfaces?: Surface[] } | undefined
    if (!Array.isArray(body?.surfaces)) return undefined
    return { surfaces: body.surfaces.filter((surface) => current.project === undefined || surface.editspace === current.project) }
  }
  // Each part keeps its last-known rows for the same project when its read failed, marked stale.
  const merged = (previous: HostFeedState, same: boolean, needs: Awaited<ReturnType<typeof readNeeds>>, surfaces: SurfaceRead) => ({
    decisions: needs.decisions ?? (same ? previous.decisions : []),
    decisionsStale: !needs.decisions,
    requests: needs.requests ?? (same ? previous.requests : []),
    requestsStale: !needs.requests,
    surfaces: surfaces && "surfaces" in surfaces ? surfaces.surfaces : surfaces ? [] : same ? previous.surfaces : [],
    surfacesStale: !surfaces,
    surfacesUnsupported: !!surfaces && "unsupported" in surfaces,
  })
  const readLineage = async (es: string) => {
    const [handoffs, dashboard] = await Promise.all([
      read<{ handoffs: Handoff[] }>(`/es/api/handoffs?es=${encodeURIComponent(es)}`),
      read<{ editspace: string; threads: { lanes?: { lane: string; owner?: string }[] }[] }>(`/es/api/state?es=${encodeURIComponent(es)}`),
    ])
    if (dashboard.editspace !== es || !Array.isArray(handoffs.handoffs) || !Array.isArray(dashboard.threads)) throw new Error("Invalid host lineage")
    return {
      edges: handoffs.handoffs,
      owners: dashboard.threads.flatMap((thread) => (thread.lanes ?? []).flatMap((lane): LaneOwner[] =>
        lane.owner ? [{ lane: lane.lane, owner: lane.owner }] : [])),
    }
  }
  const refreshLineage = () => {
    const current = scope
    // One project: its editspace. All projects: the editspaces holding this host's pinned sessions, found from that
    // host's own editspace roots.
    const all = !!current && current.project === undefined
    const key = all ? "*" : current?.es
    if (!key || (all && !pinned().length) || state().status !== "ready" || lineageRead || Date.now() - lastLineageRead < LINEAGE_MS) return
    lastLineageRead = Date.now()
    const same = () => (scope?.project === undefined ? "*" : scope?.es) === key && state().status === "ready"
    lineageRead = (async () => {
      try {
        const roots = all
          ? (await read<{ editspaces: { name: string; root: string }[] }>("/es/api/editspaces")).editspaces
              .map((item) => ({ name: item.name, base: item.root.replace(/\/+$/, "").replace(/\/\.editspace$/, "") }))
          : [{ name: key, base: "" }]
        const editspaceOf = (directory: string) => all
          ? roots.filter((item) => directory === item.base || directory.startsWith(`${item.base}/`)).toSorted((a, b) => b.base.length - a.base.length)[0]?.name
          : key
        const names = [...new Set(pinned().flatMap((directory) => editspaceOf(directory) ?? []))].slice(0, MAX_LINEAGE_EDITSPACES)
        const lineages = await Promise.all((all ? names : [key]).map(async (es) => [es, await readLineage(es)] as const))
        if (!same()) return
        setLineage({ project: key, byEditspace: Object.fromEntries(lineages), editspaceOf })
      } catch {
        // Retain this project's last-known owners so lane pins keep their place during a host outage.
      }
    })().finally(() => {
      lineageRead = undefined
      if (!same()) refreshLineage()
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
      const [needs, surfaces] = await Promise.all([readNeeds(), readSurfaces()])
      const rows = name && !root ? [] : hostRows(host.id, sessions, root)
      saveSeen(host.id, rows, name)
      setState((previous) => ({
        checkedAt: Date.now(),
        status: "ready",
        rows,
        scoped: !!root,
        ...merged(previous, same, needs, surfaces),
      }))
      refreshLineage()
    } catch (error) {
      if (scope?.project !== name) setLineage(undefined)
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
  // Decisions, requests and Surfaces have no event on the session stream: between list reads, read only those.
  const refreshDecisions = async () => {
    refreshLineage()
    const current = scope
    if (loading || state().status !== "ready" || document.visibilityState !== "visible") return
    const [needs, surfaces] = await Promise.all([readNeeds(), readSurfaces()])
    if (scope !== current) return
    setState((previous) => ({ ...previous, ...merged(previous, true, needs, surfaces) }))
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

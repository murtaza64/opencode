/* Shared dashboard state: one fetch of /es/api/state for the sidebar, board,
 * and session info panel, refreshed on the dashboard's SSE ticks. */
import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
  useContext,
  type ParentProps,
  type Resource,
} from "solid-js"
import { es, oc, type AttentionNotification } from "./api"
import { createSessionActivity } from "./session-activity"
import { createServerEvents } from "./event-source"
import { resolveProjectName } from "./project-name"
import { reconcileHostPins, reconcilePins, transferPins, type Handoff, type PendingHandoff } from "./handoffs"
import { pinSessionID } from "./session-pins"
import { createCloudAgents } from "./cloud-agents"
import { createSessionFailures } from "./session-failures"
import { coalesced } from "./coalesced"
import { background } from "./startup"
import { touchTodayCost } from "./today-cost"
import { clearBackend, describeFailure, reportBackend } from "./backend-status"
import { readHost, type WorkHost } from "./host"
import { createHostFeed, type HostFeed, type HostedRow } from "./host-feed"
import { forgetSeen, loadSeen, saveSeen } from "./last-seen"
import type { GlobalSession, SessionFailure } from "@opencode-ai/sdk/v2"
import type { Event } from "@opencode-ai/sdk/v2"

/** How often other editspaces' handoff lineage (used for cross-project pins) is re-read. */
const OTHER_LINEAGE_MS = 60_000
const INDEX_MIN_GAP_MS = 120_000
import { useLocation } from "@solidjs/router"
export { linkUrl } from "./link-url"

export type DotState = "pending" | "busy" | "failed" | "unread" | "idle"

export type SessionRow = {
  id: string
  title: string
  directory: string
  updated: number
  live?: string
  project?: string
  archived?: number
  /** A Work view host other than this page's; its rows open on that host's own tab. */
  host?: string
}

/** Other hosts' sessions in this page's Work view (only the laptop listener aggregates). */
type WorkCtx = {
  /** One feed per other Work view host, in registry order. */
  feeds: () => HostFeed[]
  host: (id: string) => WorkHost | undefined
  pinned: () => HostedRow[]
  unpinned: () => HostedRow[]
  isPinned: (row: Pick<HostedRow, "id" | "directory" | "host">) => boolean
  togglePin: (row: Pick<HostedRow, "id" | "directory" | "host">) => void
  dot: (row: HostedRow) => DotState
}

type DashboardCtx = {
  state: Resource<any>
  stateError: () => string
  refetch: () => void
  refresh: () => Promise<void>
  digest: (sessionID: string) => Promise<void>
  brief: (ticket: string) => Promise<void>
  curate: () => Promise<void>
  markViewed: (sessionID: string, force?: boolean) => void
  dotFor: (s: { id: string; live?: string; updated?: number; pending?: boolean }) => DotState
  notifications: () => AttentionNotification[]
  editspace: () => string | undefined
  setEditspace: (name: string) => void
  editspaces: Resource<{ editspaces: { name: string; root: string }[]; default: string | null }>
  mailRevision: () => number
  handoffs: Resource<Handoff[]>
  pendingHandoffs: () => PendingHandoff[]
  handoffsError: () => string
  refetchHandoffs: () => void
  laneOwners: () => { lane: string; owner: string }[]
  lineage: () => Handoff[]
  lineageOwners: () => { lane: string; owner: string }[]
  transferPin: (from: string, to: string, directory: string, targetDirectory?: string) => void
  archivedIds: () => Set<string>
  refetchArchived: () => void
  allProjects: () => boolean
  setAllProjects: (value: boolean) => void
  sessionRows: () => SessionRow[]
  sessions: () => SessionRow[]
  pinnedSessions: () => SessionRow[]
  unpinnedSessions: () => SessionRow[]
  isPinned: (s: Pick<SessionRow, "id" | "directory">) => boolean
  togglePin: (s: Pick<SessionRow, "id" | "directory">) => void
  sessionsLoading: () => boolean
  sessionsError: () => string
  activity: ReturnType<typeof createSessionActivity>
  failures: ReturnType<typeof createSessionFailures>
  /** Failed sessions in the current sidebar scope, excluding es handoff predecessors. */
  scopedFailures: () => SessionFailure[]
  handedOff: (sessionID: string) => boolean
  cloud: ReturnType<typeof createCloudAgents>
  setVisibleSessions: (ids: Set<string>) => void
  work: WorkCtx
}

const Ctx = createContext<DashboardCtx>()

export function DashboardProvider(props: ParentProps) {
  const route = useLocation()
  const [allProjects, setAllProjectsRaw] = createSignal(localStorage.getItem("es-app-all-projects") === "true")
  const setAllProjects = (value: boolean) => {
    localStorage.setItem("es-app-all-projects", String(value))
    setAllProjectsRaw(value)
  }
  const [editspace, setEditspaceRaw] = createSignal<string | undefined>(
    localStorage.getItem("es-app-editspace") ?? undefined,
  )
  const setEditspace = (name: string) => {
    setAllProjects(false)
    localStorage.setItem("es-app-editspace", name)
    setEditspaceRaw(name)
  }
  const [stateError, setStateError] = createSignal("")
  const [metadataError, setMetadataError] = createSignal("")
  const [notificationError, setNotificationError] = createSignal("")
  const [editspaces, { refetch: refetchEditspaces }] = createResource<Awaited<ReturnType<typeof es.editspaces>>>(async (_, info) => {
    try { const result = await es.editspaces(); setMetadataError(""); clearBackend("Projects"); return result }
    catch (cause) { setMetadataError("Project metadata unavailable; last-known projects retained."); reportBackend("Projects", cause); setTimeout(() => void refetchEditspaces(), 15_000); return info.value ?? { editspaces: [], default: null } }
  })
  const [mailRevision, setMailRevision] = createSignal(0)
  const [notificationState, { refetch: refetchNotifications }] = createResource<Awaited<ReturnType<typeof es.notifications>>>(async (_, info) => {
    try { const result = await es.notifications(); setNotificationError(""); clearBackend("Notifications"); return result }
    catch (cause) { setNotificationError("Notification source unavailable; last-known pointers retained."); reportBackend("Notifications", cause); return info.value ?? { notifications: [] } }
  })
  const stateCache = new Map<string, Awaited<ReturnType<typeof es.state>>>()
  const [state, { refetch }] = createResource(
    () => editspace() ?? "",
    async (name) => {
      try {
        const result = await es.state(name || undefined)
        stateCache.set(typeof result.editspace === "string" ? result.editspace : name || editspaces()?.default || "", result)
        if (!name) stateCache.set("", result)
        setStateError("")
        clearBackend("Dashboard state")
        return result
      } catch (cause) { setStateError("Dashboard source unavailable; last-known project state retained."); reportBackend("Dashboard state", cause); return stateCache.get(name || editspaces()?.default || "") ?? (!name ? stateCache.get("") : undefined) }
    },
  )
  const [handoffsError, setHandoffsError] = createSignal("")
  const [pendingHandoffs, setPendingHandoffs] = createSignal<Record<string, PendingHandoff[]>>({})
  const cloud = createCloudAgents({
    project: () => allProjects() ? undefined : editspace() ?? editspaces()?.default ?? undefined,
    defaultProject: () => editspace() ?? editspaces()?.default ?? undefined,
    targetProject: () => route.pathname === "/cloud" ? new URLSearchParams(route.search).get("es") ?? undefined : undefined,
  })
  const [handoffs, { refetch: refetchHandoffs }] = createResource<Handoff[], { name: string; revision: unknown }>(
    () => ({ name: editspace() ?? editspaces()?.default ?? "", revision: state() }),
    async ({ name }, info) => {
      if (!name) return []
      try {
        const result = await es.handoffs(name)
        setPendingHandoffs((previous) => ({ ...previous, [name]: result.pending ?? [] }))
        setHandoffsError("")
        clearBackend("Handoffs")
        return result.handoffs
      } catch (error) {
        setHandoffsError(`Handoff lineage unavailable: ${describeFailure(error)}`)
        reportBackend("Handoffs", error)
        return info.value ?? []
      }
    },
  )
  const laneOwners = createMemo(() => (state()?.threads ?? []).flatMap((thread: any) =>
    (thread.lanes ?? []).filter((lane: any) => lane.owner).map((lane: any) => ({ lane: lane.lane as string, owner: lane.owner as string }))))
  const [sessionsError, setSessionsError] = createSignal("")
  let revision = 0
  const changed = new Map<string, { revision: number; session: GlobalSession | null }>()
  const merge = (sessions: GlobalSession[], updates: Iterable<[string, { session: GlobalSession | null }]>) => {
    const rows = new Map(sessions.map((session) => [session.id, session]))
    for (const [id, value] of updates) {
      if (value.session) rows.set(id, value.session)
      else rows.delete(id)
    }
    return [...rows.values()]
  }
  const [globalSessions, { refetch: refetchGlobal, mutate: mutateGlobal }] = createResource<GlobalSession[]>(async (_, info) => {
    setSessionsError("")
    const before = revision
    try {
      const sessions = await background(() => oc.allSessions(false))
      const updates = [...changed].filter(([, item]) => item.revision > before)
      for (const [id, item] of changed) if (item.revision <= before) changed.delete(id)
      clearBackend("Sessions")
      return merge(sessions, updates)
    } catch (cause) {
      setSessionsError("Could not load session relationships. Subagent activity and requests may be incomplete. Retrying automatically.")
      reportBackend("Sessions", cause)
      return merge(info.value ?? [], changed)
    }
  })
  // The full index is large (~250 KB-1 MB) and costs Core a long read, so every background caller
  // shares one reader: at most one read in flight, and background refreshes at most every
  // INDEX_MIN_GAP_MS. Session rows follow session.* events in between. Explicit refreshes (the
  // user, a known-missing successor) are not throttled but still join an in-flight read.
  let indexRead: Promise<unknown> | undefined
  let lastIndexRead = Date.now()
  const refreshIndex = (background = true) => {
    if (indexRead || (background && Date.now() - lastIndexRead < INDEX_MIN_GAP_MS)) return
    lastIndexRead = Date.now()
    indexRead = Promise.resolve(refetchGlobal()).finally(() => { indexRead = undefined })
  }
  const [visibleSessions, setVisibleSessions] = createSignal(new Set<string>())
  const PIN_KEY = "es-app-sidebar-pins"
  const pinKey = (s: Pick<SessionRow, "id" | "directory">) => JSON.stringify([s.directory, s.id])
  const loadPins = () => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]")
      return Array.isArray(value) ? [...new Set(value.filter((key): key is string => typeof key === "string"))] : []
    } catch {
      return []
    }
  }
  const [pins, setPins] = createSignal<string[]>(loadPins())
  // One pass over the session index per index change, not per caller per event.
  const sessionIndex = createMemo(() => {
    const directory = new Map<string, string>()
    const children = new Map<string, string[]>()
    for (const row of globalSessions() ?? []) {
      directory.set(row.id, row.directory)
      if (row.parentID) children.set(row.parentID, [...(children.get(row.parentID) ?? []), row.id])
    }
    return { directory, children }
  })
  // Memoized with set equality: busy-session events re-run it, but its readers (the activity
  // refresh effect) only re-run when the set of directories actually changes.
  const relevantDirectories = createMemo(() => {
    const index = sessionIndex()
    const selected = /^\/session\/([^/]+)/.exec(route.pathname)?.[1]
    const ids = new Set([
      ...visibleSessions(),
      ...pins().flatMap((key) => pinSessionID(key) ?? []),
      ...(selected ? [selected] : []),
      ...(state()?.attention ?? []).flatMap((item: { session?: string }) => item.session ? [item.session] : []),
      ...(notificationState()?.notifications ?? []).map((item) => item.session),
      ...(state()?.threads ?? []).flatMap((thread: { sessions?: { id: string; live?: string }[] }) =>
        (thread.sessions ?? []).filter((session) => session.live === "busy" || session.live === "retry").map((session) => session.id)),
    ])
    // A visible root needs its descendants' requests even when they have no sidebar rows.
    const queue = [...ids]
    for (const id of queue) for (const child of index.children.get(id) ?? []) {
      if (ids.has(child)) continue
      ids.add(child)
      queue.push(child)
    }
    const dirs = [...ids].flatMap((id) => index.directory.get(id) ?? [])
    const direct = new URLSearchParams(route.search).get("directory")
    if (selected && direct) dirs.push(direct)
    dirs.push(...(notificationState()?.notifications ?? []).map((item) => item.directory))
    return [...new Set(dirs.filter(Boolean))].sort()
  }, [], { equals: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]) })
  const sessionEvent = (event: Event, directory: string) => {
    if (event.type !== "session.created" && event.type !== "session.updated" && event.type !== "session.deleted") return false
    const info = event.properties.info
    if (!info || typeof info !== "object" || !("id" in info) || info.id !== event.properties.sessionID ||
      !("directory" in info) || info.directory !== directory || !info.id) return false
    const removed = event.type === "session.deleted"
    if (!removed && (!("title" in info) || typeof info.title !== "string" ||
      !("time" in info) || !info.time || typeof info.time.updated !== "number" ||
      !("projectID" in info) || typeof info.projectID !== "string" ||
      !("slug" in info) || typeof info.slug !== "string" ||
      !("version" in info) || typeof info.version !== "string")) return false
    const session = removed ? null : info as GlobalSession
    changed.set(info.id, { revision: ++revision, session })
    mutateGlobal((previous) => merge(previous ?? [], [[info.id, { session }]]))
    return true
  }
  const failures = createSessionFailures()
  void failures.refresh()
  // A full read scans every root Session in Core; failed steps also request one via session.error.
  const failureInterval = setInterval(() => failures.schedule(), 300_000)
  onCleanup(() => {
    clearInterval(failureInterval)
    failures.dispose()
  })
  const activity = createSessionActivity(() => globalSessions() ?? [], () => refreshIndex(), {
    directories: relevantDirectories,
    sessionEvent,
    // A finished turn may have added spend; the title-bar total re-reads (coalesced to once a minute).
    observe: (event) => {
      failures.observe(event)
      if (event.type === "session.idle") touchTodayCost()
    },
    reconnected: failures.schedule,
  })
  createEffect(() => {
    const notifications = notificationState()?.notifications
    if (notifications) void activity.reconcileNotifications(notifications)
  })

  // one SSE subscription per selected editspace
  createEffect(() => {
    const name = editspace()
    const source = createServerEvents(`/es/api/events?${name ? `es=${encodeURIComponent(name)}` : ""}`)
    let opened = false
    // Dashboard events only say "something changed"; each answer is a whole snapshot. Bursts of
    // events collapse into at most one refetch per resource per interval (leading and trailing),
    // so the request rate no longer scales with the event rate (a 199 req/s storm on a remote host).
    const state = coalesced(() => refetch())
    const mail = coalesced(() => setMailRevision((value) => value + 1))
    source.onopen = () => {
      if (opened) mail()
      opened = true
    }
    source.onmessage = (event) => {
      state()
      if (event.data === "mail") mail()
    }
    onCleanup(() => {
      source.close()
      state.cancel()
      mail.cancel()
    })
  })
  const notificationSource = createServerEvents("/es/api/notification-events")
  notificationSource.onmessage = () => refetchNotifications()
  onCleanup(() => notificationSource.close())
  const notificationInterval = setInterval(refetchNotifications, 30_000)
  onCleanup(() => clearInterval(notificationInterval))
  const interval = setInterval(refetch, 60_000)
  onCleanup(() => clearInterval(interval))

  // unread = meaningful activity since the user last viewed the session
  const VIEWED_KEY = "es-app-viewed"
  const [viewed, setViewed] = createSignal<Record<string, number>>(
    JSON.parse(localStorage.getItem(VIEWED_KEY) ?? "{}"),
  )
  const [idleSeen, setIdleSeen] = createSignal<Record<string, number>>(
    JSON.parse(localStorage.getItem("es-app-idle-seen") ?? "{}"),
  )
  createEffect(() => {
    const visible = visibleSessions()
    const next = { ...untrack(idleSeen) }
    let changed = false
    for (const item of notificationState()?.notifications ?? []) {
      if (item.kind !== "idle") continue
      const id = activity.root(item.session)?.id ?? item.session
      if (!visible.has(id) || item.updated <= (next[id] ?? 0)) continue
      next[id] = item.updated
      changed = true
    }
    if (!changed) return
    setIdleSeen(next)
    localStorage.setItem("es-app-idle-seen", JSON.stringify(next))
  })
  // untracked read: callers invoke this from effects that must not subscribe
  // to `viewed` (writing a tracked signal from its own effect loops forever);
  // throttled so streaming sessions don't rerender the sidebar every event
  const markViewed = (sessionID: string, force = false) => {
    const current = untrack(viewed)
    const now = Date.now()
    if (!force && now - (current[sessionID] ?? 0) < 10_000) return
    const next = { ...current, [sessionID]: now }
    setViewed(next)
    localStorage.setItem(VIEWED_KEY, JSON.stringify(next))
  }

  // sessions with a pending permission/question, from the attention queue
  const pendingSessions = createMemo(() => {
    const out = new Set<string>()
    for (const item of state()?.attention ?? []) {
      if ((item.type === "permission" || item.type === "question") && item.session) out.add(item.session)
    }
    return out
  })

  // Archived ids come from the global session index (it lists archived rows and
  // follows session.updated events). Re-listing every thread directory on each
  // dashboard tick cost ~140 full /session reads per 30 s with a large editspace.
  const archived = createMemo(
    () => new Set((globalSessions() ?? []).flatMap((session) => session.time.archived ? [session.id] : [])),
    new Set<string>(),
    { equals: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)) },
  )
  // Every dashboard tick and session event delivers fresh objects; reuse
  // unchanged rows so keyed sidebar lists patch in place instead of remounting
  // every row each tick.
  const rowCache = new Map<string, SessionRow>()
  const stableRow = (row: SessionRow) => {
    const previous = rowCache.get(row.id)
    const keys = Object.keys(row) as (keyof SessionRow)[]
    if (previous && keys.length === Object.keys(previous).length && keys.every((key) => previous[key] === row[key])) return previous
    rowCache.set(row.id, row)
    return row
  }
  const localProject = () => allProjects() ? undefined : editspace() ?? editspaces()?.default ?? undefined
  const sessionRows = createMemo<SessionRow[]>(() => {
    const rows: SessionRow[] = allProjects()
      ? (globalSessions() ?? []).filter((s) => !s.parentID).map((s) => ({
          id: s.id,
          title: s.title,
          directory: s.directory,
          updated: s.time.updated,
          archived: s.time.archived,
          project: resolveProjectName(s, editspaces()?.editspaces ?? []),
        }))
      : (state()?.threads ?? [])
          .filter((t: any) => t.kind === "session" && t.sessions[0])
          .map((t: any) => t.sessions[0])
    // This host unreachable on load: its last-seen rows for this project, not an empty list.
    // When the project list itself is down, the project is unknown: take the last list, whatever its project.
    const known = allProjects() || !!editspace() || !!editspaces()?.default
    const fallback = !rows.length && (sessionsError() || stateError()) ? loadSeen("local", known ? localProject() : "*")?.rows : undefined
    const next = (fallback ?? rows).map(stableRow)
    const keep = new Set(next.map((row) => row.id))
    for (const id of rowCache.keys()) if (!keep.has(id)) rowCache.delete(id)
    return next
  })
  // Remember what this host listed, so a reload while it is down still shows it (bounded, ids and titles only).
  createEffect(() => {
    const rows = sessionRows()
    if (rows.length && !sessionsError() && !stateError()) saveSeen("local", rows, localProject())
  })
  const archivedIds = archived
  const sessions = createMemo(() => sessionRows()
    .filter((s) => !archivedIds().has(s.id))
    .sort((a, b) => b.updated - a.updated),
  )
  const isPinned = (s: Pick<SessionRow, "id" | "directory">) => pins().some((key) => pinSessionID(key) === s.id)
  const togglePin = (s: Pick<SessionRow, "id" | "directory">) => {
    const next = isPinned(s) ? pins().filter((key) => pinSessionID(key) !== s.id) : [...pins(), pinKey(s)]
    localStorage.setItem(PIN_KEY, JSON.stringify(next))
    setPins(next)
  }
  const transferPin = (from: string, to: string, directory: string, targetDirectory = directory) => {
    const next = transferPins(pins().map((key) => pinSessionID(key) === from ? pinKey({ id: from, directory }) : key), from, to, directory, targetDirectory)
    if (next.every((key, index) => key === pins()[index])) return
    setPins(next)
    try { localStorage.setItem(PIN_KEY, JSON.stringify(next)) } catch {
      // A nonessential pin write must not turn a committed draft recovery into a failure.
    }
  }
  const currentEditspaceName = () => editspace() ?? editspaces()?.default ?? ""
  // Other editspaces' lineage changes are not signalled by this editspace's event stream, so
  // re-reading them on every local state refresh only multiplied requests: each dashboard event
  // cost one state + one handoffs GET per other editspace. They refresh on their own slow clock.
  const [otherTick, setOtherTick] = createSignal(0)
  const otherInterval = setInterval(() => setOtherTick((value) => value + 1), OTHER_LINEAGE_MS)
  onCleanup(() => clearInterval(otherInterval))
  const [otherLineages] = createResource(
    () => ({ names: (editspaces()?.editspaces.map((item) => item.name) ?? []).join("\n"), selected: currentEditspaceName(), tick: otherTick() }),
    async ({ names, selected }) => Promise.all(names.split("\n").filter((name) => name && name !== selected).map(async (name) => {
      try {
        const [lineage, dashboard] = await Promise.all([background(() => es.handoffs(name)), background(() => es.state(name))])
        if (dashboard.editspace !== name) return { edges: [], owners: [], pending: [] }
        const scope = (lane: string) => JSON.stringify([name, lane])
        return {
          edges: lineage.handoffs.map((edge) => ({ ...edge, lane: scope(edge.lane) })),
          pending: (lineage.pending ?? []).map((item) => ({ ...item, lane: scope(item.lane) })),
          owners: (dashboard.threads ?? []).flatMap((thread: { lanes?: { lane: string; owner?: string }[] }) =>
            (thread.lanes ?? []).flatMap((lane) => lane.owner ? [{ lane: scope(lane.lane), owner: lane.owner }] : [])),
        }
      } catch {
        // Missing lineage in one editspace must not guess at its pinned owners.
        return { edges: [], owners: [], pending: [] }
      }
    })),
  )
  const lineage = createMemo(() => [
    ...(handoffs() ?? []).map((edge) => ({ ...edge, lane: JSON.stringify([currentEditspaceName(), edge.lane]) })),
    ...(otherLineages() ?? []).flatMap((item) => item.edges),
  ])
  const lineageOwners = createMemo(() => [
    ...laneOwners().map((owner: { lane: string; owner: string }) => ({ ...owner, lane: JSON.stringify([currentEditspaceName(), owner.lane]) })),
    ...(otherLineages() ?? []).flatMap((item) => item.owners),
  ])
  const sought = new Set<string>()
  createEffect(() => {
    const edges = [...(handoffs() ?? []), ...(otherLineages() ?? []).flatMap((item) => item.edges)]
    if (!edges.length || handoffs.loading || handoffsError()) return
    // A new successor may not have reached the global index when the receipt arrives; re-read only
    // when one is actually missing (every lineage refresh used to re-read the whole index).
    untrack(() => {
      const known = new Set((globalSessions() ?? []).map((session) => session.id))
      // Each missing successor is sought once: one on another host never appears here.
      const missing = edges.filter((edge) => !known.has(edge.successor) && !sought.has(edge.successor))
      if (!globalSessions() || !missing.length) return
      missing.forEach((edge) => sought.add(edge.successor))
      refreshIndex(false)
    })
  })
  createEffect(() => {
    if (handoffs.loading || handoffsError()) return
    const current = pins()
    const next = reconcilePins(current, lineage(), lineageOwners(), globalSessions() ?? [])
    if (next.length === current.length && next.every((key, index) => key === current[index])) return
    setPins(next)
    try { localStorage.setItem(PIN_KEY, JSON.stringify(next)) } catch {
      // Retain the reconciled pins in this window when browser storage is unavailable.
    }
  })
  const pinnedSessions = createMemo(() => {
    const byID = new Map(sessions().map((s) => [s.id, s]))
    return [...new Set(pins().flatMap((key) => pinSessionID(key) ?? []))].flatMap((id) => {
      const row = byID.get(id)
      return row ? [row] : []
    })
  })
  const unpinnedSessions = createMemo(() => sessions().filter((s) => !isPinned(s)))
  const refetchArchived = () => refreshIndex(false)

  const dotFor = (s: { id: string; live?: string; updated?: number; pending?: boolean }): DotState => {
    if (activity.pending(s.id).length) return "pending"
    const directory = activity.session(s.id)?.directory ?? ""
    if ((s.pending ?? pendingSessions().has(s.id)) &&
      ["permission", "question"].some((kind) => activity.requestState(kind as "permission" | "question", s.id, directory) === "unknown")) return "pending"
    if (activity.running(s.id).length) return "busy"
    const status = activity.status(s.id) ?? s.live
    if (status === "busy" || status === "retry") return "busy"
    if (failures.failure(s.id) && !handedOff(s.id)) return "failed"
    if (s.updated && s.updated > (viewed()[s.id] ?? 0)) return "unread"
    return "idle"
  }
  // Core excludes fenced predecessors; es lane receipts can record a handoff Core never fenced.
  const handedOff = (sessionID: string) => lineage().some((edge) => edge.predecessor === sessionID)
  const scopedFailures = createMemo(() => {
    const scope = new Set(sessions().map((s) => s.id))
    return failures.items().filter((item) => scope.has(item.sessionID) && failures.failure(item.sessionID) && !handedOff(item.sessionID))
  })
  const rawNotifications = createMemo(() => {
    const requests: AttentionNotification[] = activity.requests().map((item) => {
      const parent = activity.root(item.request.sessionID)
      return {
        id: item.request.id,
        kind: item.kind,
        session: parent?.id ?? item.request.sessionID,
        title: parent?.title ?? item.request.sessionID,
        directory: parent?.directory ?? item.directory,
        editspace: "",
        updated: parent?.time.updated ?? 0,
      }
    })
    const dashboard = (notificationState()?.notifications ?? []).filter((item) => {
      if (item.kind === "idle") return true
      const requestID = item.id.startsWith(`${item.kind}:`) ? item.id.slice(item.kind.length + 1) : item.id
      return activity.requestState(item.kind, item.session, item.directory, requestID) === "unknown"
    }).map((item) => {
      const parent = activity.root(item.session)
      return parent ? { ...item, session: parent.id, directory: parent.directory, title: parent.title } : item
    }).filter((item) => item.kind !== "idle" || (activity.idle(item.session) &&
      item.updated > Math.max(viewed()[item.session] ?? 0, idleSeen()[item.session] ?? 0)))
    return [...requests, ...dashboard]
  })
  // Stable identities across polls so the sidebar's <For> patches rows in place
  // instead of remounting every notification on each status tick.
  const notificationCache = new Map<string, AttentionNotification>()
  const notifications = createMemo(() => {
    const next = rawNotifications().map((item) => {
      const key = `${item.kind}:${item.id}:${item.session}`
      const previous = notificationCache.get(key)
      if (previous && previous.title === item.title && previous.updated === item.updated && previous.directory === item.directory) return previous
      notificationCache.set(key, item)
      return item
    })
    const keep = new Set(next.map((item) => `${item.kind}:${item.id}:${item.session}`))
    for (const key of notificationCache.keys()) if (!keep.has(key)) notificationCache.delete(key)
    return next
  })

  // Work view: other hosts listed beside this one, each read independently, so one host being
  // unreachable never blocks or empties another. Pins of another host's sessions live under that
  // host's storage prefix; this host's pin keys are unchanged.
  const owner = getOwner()
  const [feeds, setFeeds] = createSignal<HostFeed[]>([])
  // null until the project is known, so a host is not first read for the wrong scope.
  const workProject = () => allProjects() ? undefined : editspace() ?? editspaces()?.default ?? (editspaces() ? undefined : null)
  void readHost().then((info) => {
    if (info.remote) return
    // A host removed from the Work view (or unpaired) leaves no cached rows behind.
    forgetSeen(info.work.map((item) => item.id))
    runWithOwner(owner, () => setFeeds(info.work.filter((item) => item.id !== info.id).map((item) => createHostFeed(item, workProject))))
  })
  createEffect((previous: string | null | undefined) => {
    const project = workProject()
    const name = project === null ? null : project ?? ""
    if (previous !== undefined && previous !== name && name !== null) untrack(feeds).forEach((feed) => void feed.load())
    return name
  })
  const hostPinKey = (host: string) => `host:${host}:${PIN_KEY}`
  const [hostPins, setHostPins] = createSignal<Record<string, string[]>>({})
  createEffect(() => setHostPins(Object.fromEntries(feeds().map((feed) => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(hostPinKey(feed.host.id)) ?? "[]")
      return [feed.host.id, Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []]
    } catch {
      return [feed.host.id, []]
    }
  }))))
  createEffect(() => {
    for (const feed of feeds()) {
      const state = feed.state()
      const lineage = feed.lineage()
      if (state.status !== "ready" || !state.scoped || lineage?.project !== workProject()) continue
      const current = hostPins()[feed.host.id] ?? []
      const next = reconcileHostPins(feed.host.id, current, lineage, state.rows)
      if (next.length === current.length && next.every((key, index) => key === current[index])) continue
      setHostPins((previous) => ({ ...previous, [feed.host.id]: next }))
      try { localStorage.setItem(hostPinKey(feed.host.id), JSON.stringify(next)) } catch {
        // Keep the reconciled pin in this window when browser storage is unavailable.
      }
    }
  })
  const workPinned = (row: Pick<HostedRow, "id" | "directory" | "host">) =>
    !!row.host && (hostPins()[row.host] ?? []).some((key) => pinSessionID(key) === row.id)
  const work: WorkCtx = {
    feeds,
    host: (id) => feeds().find((feed) => feed.host.id === id)?.host,
    pinned: createMemo(() => feeds().flatMap((feed) => {
      const rows = new Map(feed.state().rows.map((row) => [row.id, row]))
      return (hostPins()[feed.host.id] ?? []).flatMap((key) => rows.get(pinSessionID(key) ?? "") ?? [])
    })),
    unpinned: createMemo(() => feeds().flatMap((feed) => feed.state().rows.filter((row) => !workPinned(row)))),
    isPinned: workPinned,
    togglePin: (row) => {
      if (!row.host) return
      const current = hostPins()[row.host] ?? []
      const next = workPinned(row) ? current.filter((key) => pinSessionID(key) !== row.id) : [...current, pinKey(row)]
      try { localStorage.setItem(hostPinKey(row.host), JSON.stringify(next)) } catch {
        // Keep the pin for this window when browser storage is unavailable.
      }
      setHostPins((previous) => ({ ...previous, [row.host!]: next }))
    },
    dot: (row) => {
      const feed = feeds().find((item) => item.host.id === row.host)
      const status = feed?.live(row.id)
      return status === "busy" || status === "retry" ? "busy" : "idle"
    },
  }

  const value: DashboardCtx = {
    state,
    stateError: () => [stateError(), metadataError(), notificationError()].filter(Boolean).join(" "),
    refetch: () => {
      refetch()
      if (allProjects()) refreshIndex()
    },
    refresh: async () => {
      await es.refresh(editspace())
      refetch()
    },
    digest: async (sessionID: string) => {
      try {
        await es.digest(sessionID, editspace())
      } finally {
        refetch()
      }
    },
    brief: async (ticket: string) => {
      try {
        await es.brief(ticket, editspace())
      } finally {
        refetch()
      }
    },
    curate: async () => {
      try {
        await es.curate(editspace())
      } finally {
        refetch()
      }
    },
    markViewed,
    dotFor,
    notifications,
    editspace,
    setEditspace,
    editspaces,
    mailRevision,
    handoffs,
    pendingHandoffs: () => [
      ...(pendingHandoffs()[currentEditspaceName()] ?? []).map((item) => ({ ...item, lane: JSON.stringify([currentEditspaceName(), item.lane]) })),
      ...(otherLineages() ?? []).flatMap((item) => item.pending),
    ],
    handoffsError,
    refetchHandoffs: () => { void refetchHandoffs() },
    laneOwners,
    lineage,
    lineageOwners,
    transferPin,
    archivedIds,
    refetchArchived,
    allProjects,
    setAllProjects,
    sessionRows,
    sessions,
    pinnedSessions,
    unpinnedSessions,
    isPinned,
    togglePin,
    sessionsLoading: () => allProjects() && globalSessions.loading,
    sessionsError,
    activity,
    failures,
    scopedFailures,
    handedOff,
    cloud,
    setVisibleSessions,
    work,
  }
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export function useDashboard(): DashboardCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useDashboard outside DashboardProvider")
  return ctx
}

export const sessionHref = (sid: string, directory?: string) =>
  `/session/${sid}?directory=${encodeURIComponent(directory ?? "")}`

export const ago = (ts?: number) => {
  if (!ts) return ""
  const s = (Date.now() - ts) / 1000
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export const jiraUrl = (key: string) => `https://duolingo.atlassian.net/browse/${key}`

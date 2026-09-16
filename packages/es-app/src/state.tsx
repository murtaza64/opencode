/* Shared dashboard state: one fetch of /es/api/state for the sidebar, board,
 * and session info panel, refreshed on the dashboard's SSE ticks. */
import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  untrack,
  useContext,
  type ParentProps,
  type Resource,
} from "solid-js"
import { es, oc, type AttentionNotification } from "./api"
import { createSessionActivity } from "./session-activity"
import type { GlobalSession } from "@opencode-ai/sdk/v2"

export type DotState = "pending" | "busy" | "unread" | "idle"

export type SessionRow = {
  id: string
  title: string
  directory: string
  updated: number
  live?: string
  project?: string
  archived?: number
}

type DashboardCtx = {
  state: Resource<any>
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
  archivedIds: () => Set<string>
  refetchArchived: () => void
  allProjects: () => boolean
  setAllProjects: (value: boolean) => void
  sessionRows: () => SessionRow[]
  sessions: () => SessionRow[]
  sessionsLoading: () => boolean
  sessionsError: () => string
  activity: ReturnType<typeof createSessionActivity>
  setVisibleSessions: (ids: Set<string>) => void
}

const Ctx = createContext<DashboardCtx>()

export function DashboardProvider(props: ParentProps) {
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
  const [editspaces] = createResource(es.editspaces)
  const [notificationState, { refetch: refetchNotifications }] = createResource(es.notifications)
  const [state, { refetch }] = createResource(
    () => editspace() ?? "",
    (name) => es.state(name || undefined),
  )
  const [sessionsError, setSessionsError] = createSignal("")
  const [globalSessions, { refetch: refetchGlobal }] = createResource<GlobalSession[]>(async (_, info) => {
    setSessionsError("")
    try {
      return await oc.allSessions(false)
    } catch {
      setSessionsError("Could not load session relationships. Subagent activity and requests may be incomplete. Retrying automatically.")
      return info.value ?? []
    }
  })
  const activity = createSessionActivity(() => globalSessions() ?? [], refetchGlobal)

  // one SSE subscription per selected editspace
  createEffect(() => {
    const name = editspace()
    const source = new EventSource(`/es/api/events?${name ? `es=${encodeURIComponent(name)}` : ""}`)
    source.onmessage = () => refetch()
    onCleanup(() => source.close())
  })
  const notificationSource = new EventSource("/es/api/notification-events")
  notificationSource.onmessage = () => refetchNotifications()
  onCleanup(() => notificationSource.close())
  const interval = setInterval(refetch, 60_000)
  onCleanup(() => clearInterval(interval))

  // unread = meaningful activity since the user last viewed the session
  const VIEWED_KEY = "es-app-viewed"
  const [viewed, setViewed] = createSignal<Record<string, number>>(
    JSON.parse(localStorage.getItem(VIEWED_KEY) ?? "{}"),
  )
  const [visibleSessions, setVisibleSessions] = createSignal(new Set<string>())
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

  // archived session ids, editspace-wide: the dashboard payload doesn't carry
  // the flag, so ask the daemon per distinct directory. Keyed on state() so it
  // refreshes with the dashboard's SSE ticks; the session page also refetches
  // explicitly after archiving.
  const [archived, { refetch: refetchProjectArchived }] = createResource(state, async (st: any) => {
    const dirs = [
      ...new Set<string>(
        (st?.threads ?? [])
          .filter((t: any) => t.kind === "session" && t.sessions[0]?.directory)
          .map((t: any) => t.sessions[0].directory as string),
      ),
    ]
    const out = new Set<string>()
    await Promise.all(
      dirs.map(async (d) => {
        for (const s of await oc.sessions(d).catch(() => [])) {
          if ((s as any).time?.archived) out.add(s.id)
        }
      }),
    )
    return out
  })
  const sessionRows = createMemo<SessionRow[]>(() => {
    if (allProjects()) {
      return (globalSessions() ?? []).filter((s) => !s.parentID).map((s) => ({
        id: s.id,
        title: s.title,
        directory: s.directory,
        updated: s.time.updated,
        archived: s.time.archived,
        project: s.project?.name || s.project?.worktree.split("/").filter(Boolean).at(-1) ||
          s.directory.split("/").filter(Boolean).at(-1) || s.projectID,
      }))
    }
    return (state()?.threads ?? [])
      .filter((t: any) => t.kind === "session" && t.sessions[0])
      .map((t: any) => t.sessions[0])
  })
  const archivedIds = createMemo(() => allProjects()
    ? new Set(sessionRows().filter((s) => s.archived).map((s) => s.id))
    : archived() ?? new Set<string>(),
  )
  const sessions = createMemo(() => sessionRows()
    .filter((s) => !archivedIds().has(s.id))
    .sort((a, b) => b.updated - a.updated),
  )
  const refetchArchived = () => {
    refetchProjectArchived()
    if (allProjects()) refetchGlobal()
  }

  const dotFor = (s: { id: string; live?: string; updated?: number; pending?: boolean }): DotState => {
    if (activity.pending(s.id).length) return "pending"
    const directory = activity.session(s.id)?.directory ?? ""
    if ((s.pending ?? pendingSessions().has(s.id)) &&
      ["permission", "question"].some((kind) => activity.requestState(kind as "permission" | "question", s.id, directory) === "unknown")) return "pending"
    if (activity.running(s.id).length) return "busy"
    const status = activity.status(s.id) ?? s.live
    if (status === "busy" || status === "retry") return "busy"
    if (s.updated && s.updated > (viewed()[s.id] ?? 0)) return "unread"
    return "idle"
  }
  const notifications = createMemo(() => {
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

  const value: DashboardCtx = {
    state,
    refetch: () => {
      refetch()
      if (allProjects()) refetchGlobal()
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
    archivedIds,
    refetchArchived,
    allProjects,
    setAllProjects,
    sessionRows,
    sessions,
    sessionsLoading: () => allProjects() && globalSessions.loading,
    sessionsError,
    activity,
    setVisibleSessions,
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

/** route GitHub links through ink (duo.fyi/ink), the preferred frontend */
export const linkUrl = (url: string) =>
  url.startsWith("https://github.com/") ? `https://duo.fyi/ink/${url}` : url

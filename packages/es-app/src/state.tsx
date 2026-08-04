/* Shared dashboard state: one fetch of /es/api/state for the sidebar, board,
 * and session info panel, refreshed on the dashboard's SSE ticks. */
import {
  createContext,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  untrack,
  useContext,
  type ParentProps,
  type Resource,
} from "solid-js"
import { es } from "./api"

export type DotState = "pending" | "busy" | "unread" | "idle"

type DashboardCtx = {
  state: Resource<any>
  refetch: () => void
  refresh: () => Promise<void>
  digest: (sessionID: string) => Promise<void>
  markViewed: (sessionID: string) => void
  dotFor: (s: { id: string; live?: string; updated?: number }) => DotState
}

const Ctx = createContext<DashboardCtx>()

export function DashboardProvider(props: ParentProps) {
  const [state, { refetch }] = createResource(es.state)

  const source = new EventSource("/es/api/events")
  source.onmessage = () => refetch()
  onCleanup(() => source.close())
  const interval = setInterval(refetch, 60_000)
  onCleanup(() => clearInterval(interval))

  // unread = meaningful activity since the user last viewed the session
  const VIEWED_KEY = "es-app-viewed"
  const [viewed, setViewed] = createSignal<Record<string, number>>(
    JSON.parse(localStorage.getItem(VIEWED_KEY) ?? "{}"),
  )
  // untracked read: callers invoke this from effects that must not subscribe
  // to `viewed` (writing a tracked signal from its own effect loops forever);
  // throttled so streaming sessions don't rerender the sidebar every event
  const markViewed = (sessionID: string) => {
    const current = untrack(viewed)
    const now = Date.now()
    if (now - (current[sessionID] ?? 0) < 10_000) return
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

  const dotFor = (s: { id: string; live?: string; updated?: number }): DotState => {
    if (pendingSessions().has(s.id)) return "pending"
    if (s.live === "busy" || s.live === "retry") return "busy"
    if (s.updated && s.updated > (viewed()[s.id] ?? 0)) return "unread"
    return "idle"
  }

  const value: DashboardCtx = {
    state,
    refetch,
    refresh: async () => {
      await es.refresh()
      refetch()
    },
    digest: async (sessionID: string) => {
      try {
        await es.digest(sessionID)
      } finally {
        refetch()
      }
    },
    markViewed,
    dotFor,
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

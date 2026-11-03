/* Front Desk surfaces: views a granted agent publishes (dashboard /api/surfaces) and the desk
 * embeds through the app's surface proxy (surface-proxy.ts). The list is display data; the
 * frame address comes from the app server, which owns the capability. */
import { clearBackend, reportBackend } from "./backend-status"
import { createSignal, onCleanup } from "solid-js"
import { clockTime } from "./local-time"

export type SurfaceHealth = {
  state: "ok" | "error" | "unreachable" | "unchecked"
  status?: number
  detail?: string
  checked_at?: number
  /** Last successful probe this dashboard saw; absent when it never reached the surface. */
  last_ok_at?: number | null
}
export type Surface = {
  id: string
  title: string
  summary: string | null
  kind: "url" | "path"
  owner: string
  lane: string | null
  editspace: string
  updated_at: number
  revision: number
  health: SurfaceHealth
  /** A board is standing; a deliverable is something the human asked for. */
  purpose?: "board" | "deliverable"
  created_at?: number
  requested_in?: { session: string; directory: string; title?: string }
  /** Deliverables only: the current revision was seen (shown in the operator's foreground reader, or marked seen). */
  seen?: boolean
  /** Deliverables only: when a revision was last marked seen (ms); kept after marking it unread. */
  seen_at?: number | null
  /** The deploy receipt a granted publisher recorded (dotfiles es_dashboard_surfaces.py `buildinghub`): the latest
   * receipt's state and its deploy (or, while a redeploy builds or failed, the last one that deployed). `current`:
   * that deploy is this revision's bundle; null when either side has no bundle. */
  buildinghub?: BuildingHubReceipt
}

type Deploy = { url?: string; version?: string; deployed_at?: number | string }
export type BuildingHubReceipt = Deploy & { state?: "deployed" | "building" | "failed"; last_deployed?: Deploy; current?: boolean | null }

/** The BuildingHub version a Surface links to: its last deployed receipt with a BuildingHub https url, and whether it
 * is this revision's bundle (`current`; null = not comparable). Nothing when no deploy was recorded. */
export const buildinghubLink = (surface: Pick<Surface, "buildinghub">) => {
  const receipt = surface.buildinghub
  const deploy = receipt?.state === "deployed" ? receipt : receipt?.last_deployed
  const url = deploy?.url ? URL.parse(deploy.url) : null
  if (!url || url.protocol !== "https:" || !url.hostname.endsWith(".buildinghub.duolingo.com") || url.username || url.password) return undefined
  return { url: url.href, version: deploy?.version, current: receipt?.current ?? null }
}

const PREFIX = "surface:"
export const surfaceKey = (id: string) => `${PREFIX}${id}`
export const surfaceFromKey = (key: string | undefined) => key?.startsWith(PREFIX) ? key.slice(PREFIX.length) : undefined

const clock = (at: number) => clockTime(at)

/** Short truthful health: nothing when live, otherwise what failed and when it was last seen. */
export const surfaceProblem = (health: SurfaceHealth) => {
  if (health.state === "ok" || health.state === "unchecked") return undefined
  if (health.state === "error") return health.detail ?? "error"
  return health.last_ok_at ? `offline since ${clock(health.last_ok_at)}` : "offline"
}

export const surfaceUnavailable = (surface: Surface) => surface.health.state === "unreachable"

export const isDeliverable = (surface: Surface) => surface.purpose === "deliverable"
const seenKey = (id: string, revision: number) => `${id}:${revision}`

/** New deliverables first (newest first), then seen ones. `marks` holds seen/unread writes still in flight for one
 * revision; a mark on an older revision never clears a newer one. */
export const deliverables = (list: Surface[], marks: ReadonlyMap<string, boolean>) => {
  const all = list.filter(isDeliverable).toSorted((a, b) => (b.created_at ?? b.updated_at) - (a.created_at ?? a.updated_at))
  const fresh = (surface: Surface) => !(marks.get(seenKey(surface.id, surface.revision)) ?? surface.seen)
  return { fresh: all.filter(fresh), earlier: all.filter(surface => !fresh(surface)) }
}

/** The Needs-you line for a requested deliverable: what it is, who made it, which revision, and any health problem. */
export const tryLine = (surface: Surface) =>
  [`Try · ${surface.title} · ${surface.owner} · rev ${surface.revision}`, surfaceProblem(surface.health)].filter(Boolean).join(" · ")

const POLL_MS = 15_000

// `fetch` lets a test reach a real dashboard store; the page uses its own origin.
export const createSurfaces = (options: { fetch?: (input: string, init?: RequestInit) => Promise<Response>; poll?: boolean } = {}) => {
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const [list, setList] = createSignal<Surface[]>([])
  const [error, setError] = createSignal<string>()
  const [checked, setChecked] = createSignal<number>()
  const refresh = async () => {
    type Read = { surfaces: Surface[] } | { status: number } | { cause: unknown }
    const result: Read = await send("/es/api/surfaces", { cache: "no-store" })
      .then(async (response): Promise<Read> => response.ok ? { surfaces: (await response.json()).surfaces as Surface[] } : { status: response.status })
      .catch((cause): Read => ({ cause }))
    if (!("surfaces" in result)) {
      // Load trouble keeps the last list and goes to the shared header status; a dashboard
      // without surfaces is a plain fact shown in place.
      if ("status" in result && (result.status === 404 || result.status === 501)) return setError("this dashboard does not serve surfaces")
      return reportBackend("Surfaces", "status" in result ? result : result.cause)
    }
    clearBackend("Surfaces")
    setList(result.surfaces)
    setError()
    setChecked(Date.now())
  }
  // Seen/unread writes in flight, per revision; the next list read is the truth again.
  const [marks, setMarks] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const [seenError, setSeenError] = createSignal<string>()
  const unmark = (key: string) => setMarks(new Map([...marks()].filter(([item]) => item !== key)))
  /** Mark one revision seen (or unread) on this host's dashboard; true when the dashboard saved it. */
  const markSeen = async (surface: Surface, revision: number, seen = true) => {
    if (!isDeliverable(surface)) return false
    const key = seenKey(surface.id, revision)
    setMarks(new Map([...marks(), [key, seen]]))
    const response = await send("/es/api/frontdesk/deliverables/seen", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Attention-CSRF": "1" },
      body: JSON.stringify({ id: surface.id, revision, seen }),
    }).catch(() => undefined)
    if (response?.ok) {
      setSeenError()
      await refresh()
      unmark(key)
      return true
    }
    unmark(key)
    const action = seen ? "Seen" : "Unread"
    setSeenError(response && (response.status === 401 || response.status === 403)
      ? `${action} is not saved: the operator connection is unavailable.`
      : `${action} is not saved: the dashboard did not confirm it.`)
    return false
  }
  const split = () => deliverables(list(), marks())
  void refresh()
  if (options.poll !== false) {
    const timer = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  }
  return { list, boards: () => list().filter(surface => !isDeliverable(surface)), deliverables: split, markSeen, seenError, error, checked, refresh }
}

/** The sandboxed frame address for one surface, minted by the app server, and when it lapses. */
// A mint that never answers ends as an error the pane can show and retry, not a silent blank.
export const surfaceAddress = (id: string) =>
  fetch(`/__es/surface/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }).then(async response => {
    // An app server without the surface route answers with its page fallback, not JSON.
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("this app server does not host surfaces yet")
    const body = await response.json() as { src: string; expires_at?: number }
    return { src: body.src, expiresAt: body.expires_at }
  })

/** Delay before re-minting a frame address: a few minutes ahead of expiry, never sooner than 30 s. */
export const renewDelay = (expiresAt: number | undefined, now: number) =>
  expiresAt === undefined ? undefined : Math.max(30_000, expiresAt - now - 5 * 60_000)

/* Front Desk surfaces: views a granted agent publishes (dashboard /api/surfaces) and the desk
 * embeds through the app's surface proxy (surface-proxy.ts). The list is display data; the
 * frame address comes from the app server, which owns the capability. */
import { clearBackend, reportBackend } from "./backend-status"
import { createSignal, onCleanup } from "solid-js"

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
  /** Deliverables only: the operator opened the current revision. */
  seen?: boolean
}

const PREFIX = "surface:"
export const surfaceKey = (id: string) => `${PREFIX}${id}`
export const surfaceFromKey = (key: string | undefined) => key?.startsWith(PREFIX) ? key.slice(PREFIX.length) : undefined

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/** Short truthful health: nothing when live, otherwise what failed and when it was last seen. */
export const surfaceProblem = (health: SurfaceHealth) => {
  if (health.state === "ok" || health.state === "unchecked") return undefined
  if (health.state === "error") return health.detail ?? "error"
  return health.last_ok_at ? `offline since ${clock(health.last_ok_at)}` : "offline"
}

export const surfaceUnavailable = (surface: Surface) => surface.health.state === "unreachable"

export const isDeliverable = (surface: Surface) => surface.purpose === "deliverable"
const seenKey = (surface: Surface) => `${surface.id}:${surface.revision}`

/** New deliverables first (newest first), then earlier ones; `opened` covers marks still in flight. */
export const deliverables = (list: Surface[], opened: ReadonlySet<string>) => {
  const all = list.filter(isDeliverable).toSorted((a, b) => (b.created_at ?? b.updated_at) - (a.created_at ?? a.updated_at))
  const fresh = (surface: Surface) => !surface.seen && !opened.has(seenKey(surface))
  return { fresh: all.filter(fresh), earlier: all.filter(surface => !fresh(surface)) }
}

const POLL_MS = 15_000

export const createSurfaces = () => {
  const [list, setList] = createSignal<Surface[]>([])
  const [error, setError] = createSignal<string>()
  const [checked, setChecked] = createSignal<number>()
  const refresh = async () => {
    type Read = { surfaces: Surface[] } | { status: number } | { cause: unknown }
    const result: Read = await fetch("/es/api/surfaces", { cache: "no-store" })
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
  // Opened revisions this page marked; kept even when the write fails so an opened item stops nagging here.
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set())
  const [seenError, setSeenError] = createSignal<string>()
  const markSeen = async (surface: Surface) => {
    if (!isDeliverable(surface) || surface.seen || opened().has(seenKey(surface))) return
    setOpened(new Set([...opened(), seenKey(surface)]))
    const response = await fetch("/es/api/frontdesk/deliverables/seen", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Attention-CSRF": "1" },
      body: JSON.stringify({ id: surface.id, revision: surface.revision }),
    }).catch(() => undefined)
    if (response?.ok) {
      setSeenError()
      return void refresh()
    }
    setSeenError(response && (response.status === 401 || response.status === 403)
      ? "Seen state is not saved: the operator connection is unavailable."
      : "Seen state is not saved: the dashboard did not confirm it.")
  }
  const split = () => deliverables(list(), opened())
  void refresh()
  const timer = setInterval(() => void refresh(), POLL_MS)
  onCleanup(() => clearInterval(timer))
  return { list, boards: () => list().filter(surface => !isDeliverable(surface)), deliverables: split, markSeen, seenError, error, checked, refresh }
}

/** The sandboxed frame address for one surface, minted by the app server, and when it lapses. */
export const surfaceAddress = (id: string) =>
  fetch(`/__es/surface/${encodeURIComponent(id)}`, { cache: "no-store" }).then(async response => {
    // An app server without the surface route answers with its page fallback, not JSON.
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("this app server does not host surfaces yet")
    const body = await response.json() as { src: string; expires_at?: number }
    return { src: body.src, expiresAt: body.expires_at }
  })

/** Delay before re-minting a frame address: a few minutes ahead of expiry, never sooner than 30 s. */
export const renewDelay = (expiresAt: number | undefined, now: number) =>
  expiresAt === undefined ? undefined : Math.max(30_000, expiresAt - now - 5 * 60_000)

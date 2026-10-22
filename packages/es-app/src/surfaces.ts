/* Front Desk surfaces: views a granted agent publishes (dashboard /api/surfaces) and the desk
 * embeds through the app's surface proxy (surface-proxy.ts). The list is display data; the
 * frame address comes from the app server, which owns the capability. */
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

const POLL_MS = 15_000

export const createSurfaces = () => {
  const [list, setList] = createSignal<Surface[]>([])
  const [error, setError] = createSignal<string>()
  const [checked, setChecked] = createSignal<number>()
  const refresh = async () => {
    const result = await fetch("/es/api/surfaces", { cache: "no-store" })
      .then(async response => response.ok ? { surfaces: (await response.json()).surfaces as Surface[] } : { error: response.status === 404 ? "this dashboard does not serve surfaces" : `surfaces HTTP ${response.status}` })
      .catch(() => ({ error: "dashboard unreachable" }))
    if ("error" in result) return setError(result.error)
    setList(result.surfaces)
    setError()
    setChecked(Date.now())
  }
  void refresh()
  const timer = setInterval(() => void refresh(), POLL_MS)
  onCleanup(() => clearInterval(timer))
  return { list, error, checked, refresh }
}

/** The sandboxed frame address for one surface, minted by the app server. */
export const surfaceAddress = (id: string) =>
  fetch(`/__es/surface/${encodeURIComponent(id)}`, { cache: "no-store" }).then(async response => {
    // An app server without the surface route answers with its page fallback, not JSON.
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("this app server does not host surfaces yet")
    return (await response.json() as { src: string }).src
  })

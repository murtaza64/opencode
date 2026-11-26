/* Front Desk surfaces: views a granted agent publishes (dashboard /api/surfaces) and the desk
 * embeds through the app's surface proxy (surface-proxy.ts). The list is display data; the
 * frame address comes from the app server, which owns the capability. */
import { pageHidden } from "./page-visible"
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
/** A withdrawn Surface as its host remembers it (DD #765): never its content. */
export type SurfaceTombstone = { id: string; title: string; owner: string; editspace: string; revision: number; withdrawn_at: number }
export type SurfaceIntent = "fyi" | "review" | "decision"
export type SurfaceLook = { label: string; id?: string; selector?: string }
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
  /** The author's change note for the current revision (null: none given). Absent on hosts without notes. */
  whats_new?: string | null
  /** Earlier revisions' notes too, newest first (bounded by the host). A record may carry only a change (no text). */
  notes?: { revision: number; text?: string; at?: number; base?: number; intent?: SurfaceIntent; look?: SurfaceLook[]; respond?: string }[]
  /** What the current revision asks (DD #753): the revision it compares against (default the previous), its intent,
   * places to look and the question it asks. Absent on hosts without it. */
  change?: { base: number | null; intent: SurfaceIntent | null; look: SurfaceLook[]; respond: string | null }
}

type Deploy = { url?: string; version?: string; deployed_at?: number | string; source_revision?: number }
export type BuildingHubReceipt = Deploy & { state?: "deployed" | "building" | "failed"; last_deployed?: Deploy; current?: boolean | null
  /** How the deployed copy relates to this revision (DD #782): built from it, from an older revision, or another copy. */
  copy?: "current" | "older" | "different" | null
  /** False when "from rN" is not pinned to that revision's bytes (a path Surface has no frozen bundle). */
  source_verified?: boolean }

/** The BuildingHub version a Surface links to: its last deployed receipt with a BuildingHub https url, and whether it
 * is this revision's bundle (`current`; null = not comparable). Nothing when no deploy was recorded. */
export const buildinghubLink = (surface: Pick<Surface, "buildinghub">) => {
  const receipt = surface.buildinghub
  const deploy = receipt?.state === "deployed" ? receipt : receipt?.last_deployed
  const url = deploy?.url ? URL.parse(deploy.url) : null
  if (!url || url.protocol !== "https:" || !url.hostname.endsWith(".buildinghub.duolingo.com") || url.username || url.password) return undefined
  return { url: url.href, version: deploy?.version, current: receipt?.current ?? null, copy: receipt?.copy ?? null, from: deploy?.source_revision,
    unverified: receipt?.source_verified === false && receipt?.copy === "current" && !!deploy?.source_revision }
}

/** The reader's Share line for BuildingHub (DD #782). The link is offered only for a copy built from the revision on
 * the host now; an older or different copy is named, never linked as if it were this revision. */
export const buildinghubShare = (surface: Pick<Surface, "buildinghub" | "revision">) => {
  const link = buildinghubLink(surface)
  if (!link) return { state: "none" as const, text: "Not on BuildingHub" }
  const version = link.version ? ` ${link.version}` : ""
  // Hosts without lineage compare bundles only (`current`).
  const copy = link.copy ?? (link.current === true ? "current" : link.current === false ? "different" : null)
  if (copy === "current") return { state: "current" as const, text: `On BuildingHub:${version}${link.from ? ` from r${link.from}` : ""}${link.unverified ? " (bundle not verified)" : ""}`, url: link.url }
  if (copy === "older") return { state: "older" as const, text: `BuildingHub copy${version} is from r${link.from ?? "?"} (older than r${surface.revision})` }
  return { state: "different" as const, text: `BuildingHub has a different copy${version}` }
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
  const [withdrawn, setWithdrawn] = createSignal<SurfaceTombstone[]>([])
  const [error, setError] = createSignal<string>()
  const [checked, setChecked] = createSignal<number>()
  const refresh = async () => {
    type Read = { surfaces: Surface[]; withdrawn?: SurfaceTombstone[] } | { status: number } | { cause: unknown }
    const result: Read = await send("/es/api/surfaces", { cache: "no-store" })
      .then(async (response): Promise<Read> => { if (!response.ok) return { status: response.status }; const body = await response.json(); return { surfaces: body.surfaces as Surface[], withdrawn: Array.isArray(body.withdrawn) ? body.withdrawn : [] } })
      .catch((cause): Read => ({ cause }))
    if (!("surfaces" in result)) {
      // Load trouble keeps the last list and goes to the shared header status; a dashboard
      // without surfaces is a plain fact shown in place.
      if ("status" in result && (result.status === 404 || result.status === 501)) return setError("this dashboard does not serve surfaces")
      return reportBackend("Surfaces", "status" in result ? result : result.cause)
    }
    clearBackend("Surfaces")
    setList(result.surfaces)
    setWithdrawn(result.withdrawn ?? [])
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
    const timer = setInterval(() => { if (!pageHidden()) void refresh() }, POLL_MS)
    onCleanup(() => clearInterval(timer))
  }
  return { list, withdrawn, boards: () => list().filter(surface => !isDeliverable(surface)), deliverables: split, markSeen, seenError, error, checked, refresh }
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

/* Shared pins (contract work-hosts-and-pins v0.2.2 §3): each pin lives in its own host's dashboard store, one per host
 * and profile, and every client shows the union over the hosts it reaches. This is the desktop client of one host's
 * store: it reads `?since=<rev>` changes, writes pin / unpin / reorder only to that host (this page's own `/es`, or
 * another Work host through the Local listener's `/hosts/<id>/es`), and keeps unsent writes in a per-host outbox that
 * replays to the same host only. The outbox is a queue of writes, not a pin store: the host's store is the only
 * authority, and this client's pins are a view of it.
 *
 * Identity: a client is keyed by the host's verified id from `/__es/host`; a host that reports `local` (no configured
 * identity) is unknown and never syncs. A store answering for another profile is refused. */
import { createSignal } from "solid-js"
import type { ReachReason } from "./host-feed"
import { reasonFor } from "./host-feed"

export type Pin = { ref: string; pinnedAt: number; order?: number | null; orderAt?: number | null }
export type PinListing = { rev: number; reset?: true; profile?: string; pins: Pin[]; tombstones: { ref: string; at: number }[] }
export type PinCurrent = { state: "pinned"; pinnedAt: number; order?: number | null; orderAt?: number | null } | { state: "unpinned"; at: number } | null
export type PinWriteResult = { rev: number; applied: boolean; current: PinCurrent }
export type PinKind = "pin" | "unpin" | "order"
type PinBody = { at: number; op: string; order?: number; migrate?: true }
type Queued = { kind: PinKind; ref: string; body: PinBody }

const REF = /^(?:session:[A-Za-z0-9_-]{1,128}|lane:[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,64})$/
const HOST_ID = /^[a-z][a-z0-9-]{0,31}$/
const HORIZON_MS = 30 * 86_400_000

/** A lane pin follows the lane through handoffs; use it whenever the session belongs to a lane. */
export const lanePinRef = (editspace: string, lane: string) => `lane:${editspace}/${lane}`
export const sessionPinRef = (session: string) => `session:${session}`
export const validPinRef = (ref: string) => REF.test(ref)

/** The store path of one ref: a single segment, the lane slash encoded once (the listener and gateway allowlists match it). */
export const pinPath = (ref: string) => `/es/api/pins/${ref.replace("/", "%2F")}`

/** Key of a pin across hosts: the same ref on two hosts is two pins. */
export const pinUnionKey = (host: string, ref: string) => `${host}|${ref}`

/** Whether a host id may sync pins: a verified federation id, never the `local` alias or a port or origin. */
export const syncableHost = (id: string | undefined): id is string => !!id && id !== "local" && HOST_ID.test(id)

/** One host's pins after a change listing: a reset replaces them; otherwise changed pins replace theirs and tombstones remove. */
export const applyListing = (pins: Pin[], listing: Pick<PinListing, "reset" | "pins" | "tombstones">) => {
  if (listing.reset) return listing.pins
  const changed = new Set([...listing.pins, ...listing.tombstones].map((item) => item.ref))
  return [...pins.filter((pin) => !changed.has(pin.ref)), ...listing.pins]
}

/** One host's pins in display order: explicit order first (ascending), then most recently pinned. */
export const orderedPins = (pins: Pin[]) => pins.toSorted((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || b.pinnedAt - a.pinnedAt)

/** The one-time import of this device's local pins into a host's store: the stored pin time or 0 (never now), and an op
 * derived from (host, ref, time) so a repeated import is an exact retry, not a second change. A migrate PUT cannot
 * override an unpin the store already holds. */
export const migrationOps = (host: string, local: { ref: string; pinnedAt?: number }[]): Queued[] =>
  [...new Map(local.filter((item) => validPinRef(item.ref)).map((item) => [item.ref, item])).values()].map((item) => ({
    kind: "pin",
    ref: item.ref,
    body: { at: item.pinnedAt ?? 0, op: `mig-${digest(`${host}\n${item.ref}\n${item.pinnedAt ?? 0}`)}`, migrate: true },
  }))

export type PinsState = {
  status: "loading" | "ready" | "unavailable"
  reason?: ReachReason | "profile"
  rev: number
  pins: Pin[]
  checkedAt?: number
  /** Writes not yet confirmed by the host. */
  pending: number
  /** Changes this client gave up on (refused, or older than 30 days), shown as "pin change not synced". */
  notSynced: { ref: string; kind: PinKind; reason: string }[]
}

/** The client of one host's pin store. `prefix`: "" for this page's own host, "/hosts/<id>" for another Work host.
 * `profile`: the profile this view lists; a store of another profile is refused. */
export const createPinsClient = (options: { host: string; prefix: string; profile: string; now?: () => number; storage?: Storage; fetch?: (input: string, init?: RequestInit) => Promise<Response> }) => {
  if (!syncableHost(options.host)) throw new Error(`Pins sync needs a verified host id, not ${JSON.stringify(options.host)}`)
  const now = options.now ?? Date.now
  const storage = options.storage ?? localStorage
  const send = options.fetch ?? fetch
  const outboxKey = `es-pins-outbox:${options.host}`
  const loadOutbox = (): Queued[] => {
    try {
      const value: unknown = JSON.parse(storage.getItem(outboxKey) ?? "[]")
      return Array.isArray(value) ? value.filter((item): item is Queued => !!item && typeof item.ref === "string" && typeof item.kind === "string" && !!item.body) : []
    } catch {
      return []
    }
  }
  let outbox = loadOutbox()
  const saveOutbox = () => {
    try { storage.setItem(outboxKey, JSON.stringify(outbox)) } catch {
      // The write still goes out; only its retry across a reload is lost.
    }
  }
  const [state, setState] = createSignal<PinsState>({ status: "loading", rev: 0, pins: [], pending: outbox.length, notSynced: [] })
  let bootstrapped = false

  const read = async () => {
    const since = state().status === "loading" ? undefined : state().rev
    const response = await send(`${options.prefix}/es/api/pins${since === undefined ? "" : `?since=${since}`}`, { cache: "no-store", credentials: "include" }).catch(() => undefined)
    if (!response?.ok || !response.headers.get("content-type")?.includes("application/json")) {
      await response?.body?.cancel()
      return setState((previous) => ({ ...previous, status: "unavailable", reason: response ? reasonFor(response.status) : "network", checkedAt: now() }))
    }
    const listing = (await response.json()) as PinListing
    if (listing.profile !== undefined && listing.profile !== options.profile)
      return setState((previous) => ({ ...previous, status: "unavailable", reason: "profile", pins: [], checkedAt: now() }))
    setState((previous) => ({
      ...previous,
      status: "ready",
      reason: undefined,
      rev: listing.rev,
      pins: applyListing(since === undefined ? [] : previous.pins, since === undefined ? { ...listing, reset: true } : listing),
      checkedAt: now(),
    }))
  }

  // One write, sent with the operator's session on that host; a missing session is set up once and the same op retried.
  const deliver = async (item: Queued): Promise<"done" | "retry" | "dropped"> => {
    const post = () => send(`${options.prefix}${pinPath(item.ref)}${item.kind === "order" ? "/order" : ""}`, {
      method: item.kind === "pin" ? "PUT" : item.kind === "unpin" ? "DELETE" : "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json", "X-Attention-CSRF": "1" },
      body: JSON.stringify(item.body),
    }).catch(() => undefined)
    let response = await post()
    if (response && (response.status === 401 || response.status === 403) && !bootstrapped) {
      bootstrapped = true
      await response.body?.cancel()
      const session = await send(`${options.prefix}/es/api/attention/session`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" }).catch(() => undefined)
      await session?.body?.cancel()
      response = await post()
    }
    if (!response || response.status >= 500 || response.status === 401 || response.status === 403) {
      await response?.body?.cancel()
      return "retry"
    }
    // An imported pin older than 30 days whose ref the store already holds: the store's own state stands.
    if (response.status === 410 && item.body.migrate) {
      await response.body?.cancel()
      return "done"
    }
    if (!response.ok) {
      const error = await response.json().then((body: { error?: string }) => body.error).catch(() => undefined)
      setState((previous) => ({ ...previous, notSynced: [...previous.notSynced, { ref: item.ref, kind: item.kind, reason: error ?? `HTTP ${response.status}` }] }))
      return "dropped"
    }
    const result = (await response.json()) as PinWriteResult
    setState((previous) => ({ ...previous, pins: withCurrent(previous.pins, item.ref, result.current) }))
    return "done"
  }

  // Replays this host's outbox in order; one that cannot be sent now stops the replay, so order is kept.
  let flushing: Promise<void> | undefined
  const flush = (): Promise<void> => (flushing ??= (async () => {
    while (outbox.length) {
      const item = outbox[0]!
      if (item.body.at < now() - HORIZON_MS && !item.body.migrate) {
        setState((previous) => ({ ...previous, notSynced: [...previous.notSynced, { ref: item.ref, kind: item.kind, reason: "older than 30 days" }] }))
        outbox = outbox.slice(1)
        saveOutbox()
        continue
      }
      const outcome = await deliver(item)
      if (outcome === "retry") break
      outbox = outbox.slice(1)
      saveOutbox()
    }
    setState((previous) => ({ ...previous, pending: outbox.length }))
  })().finally(() => (flushing = undefined)))

  const enqueue = (items: Queued[]) => {
    outbox = [...outbox, ...items]
    saveOutbox()
    setState((previous) => ({ ...previous, pending: outbox.length }))
    return flush()
  }
  const write = (kind: PinKind, ref: string, order?: number) => {
    if (!validPinRef(ref)) throw new Error(`Invalid pin ref ${JSON.stringify(ref)}`)
    return enqueue([{ kind, ref, body: { at: now(), op: crypto.randomUUID(), ...(kind === "order" ? { order } : {}) } }])
  }
  const migratedKey = `es-pins-migrated:${options.host}`

  return {
    host: options.host,
    state,
    /** Reads this host's changes since the last read (all pins on the first), then replays unsent writes. */
    refresh: async () => {
      await read()
      if (outbox.length && state().status === "ready") await flush()
    },
    pin: (ref: string) => write("pin", ref),
    unpin: (ref: string) => write("unpin", ref),
    reorder: (ref: string, order: number) => write("order", ref, order),
    /** The one-time import of this device's local pins for this host; marked done per (device, host) once sent. */
    migrate: async (local: { ref: string; pinnedAt?: number }[]) => {
      if (storage.getItem(migratedKey)) return
      // An import still waiting in the outbox is replayed, not queued again.
      await (outbox.some((item) => item.body.migrate) ? flush() : enqueue(migrationOps(options.host, local)))
      if (!outbox.some((item) => item.body.migrate)) storage.setItem(migratedKey, String(now()))
    },
  }
}

export type PinsClient = ReturnType<typeof createPinsClient>

/** A write's answer applied to one host's pins: the store's current state for that ref, whichever op won. */
const withCurrent = (pins: Pin[], ref: string, current: PinCurrent) => {
  const rest = pins.filter((pin) => pin.ref !== ref)
  return current?.state === "pinned" ? [...rest, { ref, pinnedAt: current.pinnedAt, order: current.order, orderAt: current.orderAt }] : rest
}

// A short stable digest (two 32-bit FNV-1a lanes) for derived op ids.
const digest = (value: string) => {
  const lane = (seed: number) => {
    let hash = seed
    for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0
    return hash.toString(16).padStart(8, "0")
  }
  return lane(2166136261) + lane(0x811c9dc5 ^ 0x5bd1e995)
}

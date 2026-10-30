/* Sidebar clock from turn boundaries only. A session's recency is the later of its current turn's start
 * and end as Core recorded them (Session.time.turn, advertised by session.turnTime); content, parts,
 * tools, titles and polls never move it. Without that field the time is unknown: such rows keep a stable
 * order and are never placed by time.updated, creation time or arrival time. Pure: no clock, no timer. */

/** Core's durable turn boundaries (next Core candidate). Either may be absent. */
export type TurnTime = { started?: number; ended?: number }

/** Live status of the session on the row's own host; "unknown" when that host gives none (idle, held, offline). */
export type LiveStatus = "busy" | "retry" | "idle" | "unknown"

export type TurnClock = {
  /** Host-qualified identity: the same session ID on two hosts is two clocks. */
  key: string
  /** Sort and day-group time; undefined when Core recorded no boundary. */
  recency?: number
  /** Current turn start, only while the turn is active; the elapsed tooltip counts from it. */
  started?: number
  state: "active" | "ended" | "unknown"
  /** Busy or retrying on the row's own host now. Groups active rows above idle without needing turn fields. */
  live: boolean
}

export const turnClock = (row: { host: string; id: string; turn?: TurnTime; status: LiveStatus }): TurnClock => {
  const key = `${row.host}:${row.id}`
  const live = row.status === "busy" || row.status === "retry"
  const started = valid(row.turn?.started)
  const ended = valid(row.turn?.ended)
  const recency = started === undefined && ended === undefined ? undefined : Math.max(started ?? 0, ended ?? 0)
  // An end at or after the start closes that turn (same millisecond included); an older end belongs to an earlier turn.
  const open = started !== undefined && (ended === undefined || ended < started)
  // Running needs both a recorded open start and fresh busy status from the row's host, so a crash that
  // never recorded an end, or an idle/offline host, never shows a running clock.
  if (open && live) return { key, recency, started, state: "active", live }
  if (!open && ended !== undefined) return { key, recency, state: "ended", live }
  return { key, recency, state: "unknown", live }
}

/** Default sidebar order (NAV-11): rows live on their own host above idle ones; within each group, known
 * recency newest first, then unknown rows by title and key. Parts and tool progress change none of these
 * inputs, so adjacent active rows keep their order until a status or turn boundary changes. */
export const compareRows = (a: { clock: TurnClock; title: string }, b: { clock: TurnClock; title: string }) => {
  if (a.clock.live !== b.clock.live) return a.clock.live ? -1 : 1
  const x = a.clock.recency
  const y = b.clock.recency
  if (x !== undefined && y !== undefined && x !== y) return y - x
  if (x !== undefined && y === undefined) return -1
  if (x === undefined && y !== undefined) return 1
  if (x === undefined) return a.title.localeCompare(b.title) || a.clock.key.localeCompare(b.clock.key)
  return a.clock.key.localeCompare(b.clock.key)
}

const valid = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

/** The row's latest turn boundary (later of start and end) from Core's Session.time.turn; undefined when Core
 * recorded none (an older Core without session.turnTime never sends the field). Never time.updated. */
export const turnAt = (turn: TurnTime | undefined) => {
  const started = valid(turn?.started)
  const ended = valid(turn?.ended)
  return started === undefined && ended === undefined ? undefined : Math.max(started ?? 0, ended ?? 0)
}

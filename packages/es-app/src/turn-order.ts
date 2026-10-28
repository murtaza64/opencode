/* One ordering and date-grouping input for every Work row (this host's sessions, other Work hosts'
 * sessions, Wingman agents): the time of the row's last TURN BOUNDARY (a turn started or ended), never a
 * streamed chunk, tool event, fetch or poll. Live status and content stay reactive elsewhere; a row only
 * moves when its boundary moves. A row with no known boundary is undated: it keeps a stable place after
 * the dated rows (by its own identity), never "Today".
 *
 * Sources:
 * - sessions (Local and other Work hosts): runtime-options' recency(session).at, from Core's durable
 *   Session.time.turn (runtime-lag), never session.time.updated. The current-turn tooltip state is
 *   runtime-options' turnClock, not here.
 * - Wingman: unknown (undated) until Wingman reports real turn boundaries. `wingman-activity` (when sync
 *   saw a change) is display-only and `wingman-synced` (fetch time) is never used. */

export type Ordered = { key: string; boundary?: number }

export type DateGroup = "today" | "yesterday" | "week" | "older" | "undated"

/** Newest boundary first; undated rows last, in a stable order by key (never by when they were fetched). */
export const byBoundary = (a: Ordered, b: Ordered) => {
  if (a.boundary !== undefined && b.boundary !== undefined) return b.boundary - a.boundary || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  if (a.boundary !== undefined) return -1
  if (b.boundary !== undefined) return 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** The date heading a row sits under, from its boundary only. */
export const dateGroup = (boundary: number | undefined, now: number): DateGroup => {
  if (boundary === undefined) return "undated"
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  if (boundary >= today) return "today"
  if (boundary >= today - 86_400_000) return "yesterday"
  if (boundary >= today - 6 * 86_400_000) return "week"
  return "older"
}



export * as SessionHistory from "./history"

import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { and, asc, eq, gt, lte, sql } from "drizzle-orm"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"
import { NotFoundError } from "@/storage/storage"

/**
 * The runner's model history (`MessageV2.filterCompactedEffect`), maintained incrementally.
 *
 * Every write to a Session's messages and parts is a durable event on the Session aggregate, committed in
 * the same transaction as its projection. A cached window is therefore current exactly when the Session's
 * durable sequence has not moved. When it has moved, the events since the cached sequence name the
 * messages that changed; those messages are re-read from the projected tables (never from event payloads),
 * so the result equals a full reload. Any event this module does not understand forces a full reload.
 *
 * The cached window is the raw newest-first scan `filterCompactedEffect` performs (back to the last
 * compaction boundary), stored oldest first.
 */

// `whole` is true when the window reaches the Session's first message (no compaction boundary stopped it).
type Entry = { seq: number; items: SessionV1.WithParts[]; whole: boolean }

const MAX_SESSIONS = 64
const cache = new Map<string, Entry>()
const counts = { scans: 0, advances: 0, hits: 0 }

/** Events on the Session aggregate that never change its messages or parts. */
const HISTORY_NEUTRAL = new Set([
  "session.created",
  "session.updated",
  "session.input.admitted",
  "session.input.wake-observed",
  "session.input.presented",
  "session.input.handled",
  "session.input.cancelled",
  "session.input.updated",
])

export const load = Effect.fn("SessionHistory.load")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  // Read the sequence before any rows: rows read afterwards are at least that current.
  const seq =
    (yield* db
      .select({ seq: EventSequenceTable.seq })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .get()
      .pipe(Effect.orDie))?.seq ?? 0
  const entry = cache.get(sessionID)
  const advanced = entry && entry.seq <= seq ? yield* advance(sessionID, entry, seq) : undefined
  // A window cut at a compaction boundary cannot grow backwards: if the boundary disappeared, rescan.
  const usable = advanced && (entry!.whole || stops(advanced)) ? advanced : undefined
  if (!usable) counts.scans++
  else if (entry!.seq === seq) counts.hits++
  else counts.advances++
  return remember(sessionID, seq, usable ?? (yield* scan(sessionID)), usable ? entry!.whole : true)
})

function stops(items: SessionV1.WithParts[]) {
  const filter = MessageV2.compactedFilter()
  for (let index = items.length - 1; index >= 0; index--) if (filter.push(items[index]!)) return true
  return false
}

/**
 * The newest message matching `predicate`, searching newest first like `Session.findMessage`, from the
 * fresh cached window. Undefined when no match is inside the window and the window does not reach the
 * Session's first message; the caller then searches the full history.
 */
export const newest = Effect.fn("SessionHistory.newest")(function* (
  sessionID: SessionID,
  predicate: (message: SessionV1.WithParts) => boolean,
) {
  yield* load(sessionID)
  const entry = cache.get(sessionID)
  if (!entry) return undefined
  for (let index = entry.items.length - 1; index >= 0; index--)
    if (predicate(entry.items[index]!)) return { found: entry.items[index]! }
  return entry.whole ? { found: undefined } : undefined
})

/** Drops every cached window (tests, or after writes that bypass durable events). */
export function clear() {
  cache.clear()
  counts.scans = counts.advances = counts.hits = 0
}

/** Load outcomes since the last `clear`: full scans, incremental advances, unchanged hits. */
export function stats() {
  return { ...counts }
}

function remember(sessionID: string, seq: number, items: SessionV1.WithParts[], whole: boolean) {
  const filter = MessageV2.compactedFilter()
  const newestFirst = items.toReversed()
  let kept = newestFirst.length
  let stopped = false
  for (let index = 0; index < newestFirst.length; index++) {
    if (!filter.push(newestFirst[index]!)) continue
    kept = index + 1
    stopped = true
    break
  }
  cache.delete(sessionID)
  // Whole only if nothing before it was ever cut and no boundary stopped this scan.
  cache.set(sessionID, { seq, items: newestFirst.slice(0, kept).reverse(), whole: whole && !stopped })
  if (cache.size > MAX_SESSIONS) cache.delete(cache.keys().next().value!)
  return filter.result()
}

/** The full newest-first scan, as `filterCompactedEffect` reads it. */
const scan = Effect.fnUntraced(function* (sessionID: SessionID) {
  const filter = MessageV2.compactedFilter()
  const raw: SessionV1.WithParts[] = []
  let before: string | undefined
  while (true) {
    const next = yield* MessageV2.page({ sessionID, limit: 50, before }).pipe(
      Effect.catchIf(NotFoundError.isInstance, () =>
        Effect.succeed({ items: [] as SessionV1.WithParts[], more: false, cursor: undefined }),
      ),
    )
    for (let index = next.items.length - 1; index >= 0; index--) {
      raw.push(next.items[index]!)
      if (filter.push(next.items[index]!)) return raw.reverse()
    }
    if (!next.more || !next.cursor) return raw.reverse()
    before = next.cursor
  }
})

/** Applies the events since the cached sequence; undefined means a full reload is required. */
const advance = Effect.fnUntraced(function* (sessionID: SessionID, entry: Entry, seq: number) {
  if (entry.seq === seq) return entry.items
  const { db } = yield* Database.Service
  const events = yield* db
    .select({
      seq: EventTable.seq,
      type: EventTable.type,
      message: sql<string | null>`coalesce(json_extract(${EventTable.data}, '$.info.id'), json_extract(${EventTable.data}, '$.part.messageID'), json_extract(${EventTable.data}, '$.messageID'))`,
    })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), gt(EventTable.seq, entry.seq), lte(EventTable.seq, seq)))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  if (events.length !== seq - entry.seq) return undefined
  const changed = new Set<string>()
  for (const event of events) {
    const type = event.type.replace(/\.\d+$/, "")
    if (HISTORY_NEUTRAL.has(type)) continue
    if (
      (type === "message.updated" ||
        type === "message.removed" ||
        type === "message.part.updated" ||
        type === "message.part.removed" ||
        type === "session.input.promoted") &&
      event.message
    ) {
      changed.add(event.message)
      continue
    }
    return undefined
  }
  if (changed.size === 0) return entry.items
  const fresh = yield* MessageV2.byIDs({ sessionID, ids: [...changed] })
  const byID = new Map(entry.items.map((item) => [item.info.id as string, item]))
  for (const id of changed) byID.delete(id)
  for (const item of fresh) byID.set(item.info.id, item)
  return [...byID.values()].sort((a, b) =>
    a.info.time.created !== b.info.time.created ? a.info.time.created - b.info.time.created : a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0,
  )
})

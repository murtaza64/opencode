export * as UsageRollup from "./rollup"

import os from "node:os"
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { DatabaseReader } from "../database/reader"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { MessageTable, SessionTable } from "../session/sql"
import { UsageHourlyTable, UsageRollupStateTable } from "./sql"

/**
 * Estimated spend on this host, kept as an hourly rollup so reads never scan history.
 *
 * Costs are the ones stored on messages and step-finish parts: tokens priced by the local model catalog, not
 * provider billing. Only spend that ran on this host counts: replayed events (sessions synced or moved from
 * another host) are skipped, so the same message is never counted on two hosts.
 */

type Db = Database.Interface["db"]
export type Usage = {
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

const HOUR = 3_600_000
const BACKFILL_CHUNK = 10_000
const BACKFILL_PAUSE = "20 millis"

/** Adds (`sign` 1) or retracts (-1) one step's usage for `messageID`; called inside the projecting transaction. */
export const apply = Effect.fnUntraced(function* (db: Db, messageID: string, usage: Usage, sign: 1 | -1) {
  if (yield* EventV2.Replaying) return
  const message = yield* db
    .select({
      time: MessageTable.time_created,
      session: MessageTable.session_id,
      role: sql<string | null>`json_extract(${MessageTable.data}, '$.role')`,
      provider: sql<string | null>`json_extract(${MessageTable.data}, '$.providerID')`,
      model: sql<string | null>`json_extract(${MessageTable.data}, '$.modelID')`,
    })
    .from(MessageTable)
    .where(eq(MessageTable.id, messageID as never))
    .get()
    .pipe(Effect.orDie)
  if (!message || message.role !== "assistant") return
  const state = yield* db.select().from(UsageRollupStateTable).where(eq(UsageRollupStateTable.id, 1)).get().pipe(Effect.orDie)
  // Messages older than the cutoff belong to the backfill, which reads their final totals.
  if (!state || message.time < state.cutoff) return
  yield* add(db, [
    {
      hour: Math.floor(message.time / HOUR),
      session_id: message.session,
      provider_id: message.provider ?? "unknown",
      model_id: message.model ?? "unknown",
      cost: usage.cost * sign,
      tokens_input: usage.tokens.input * sign,
      tokens_output: usage.tokens.output * sign,
      tokens_reasoning: usage.tokens.reasoning * sign,
      tokens_cache_read: usage.tokens.cache.read * sign,
      tokens_cache_write: usage.tokens.cache.write * sign,
    },
  ])
})

/**
 * Counts assistant messages created before the cutoff, once. `reader` runs the history aggregate (off the
 * event loop when it is a reader-worker connection); `writer` stores the result atomically with the done mark.
 */
export const backfill = Effect.fn("UsageRollup.backfill")(function* (writer: Db, reader: Db, chunkSize = BACKFILL_CHUNK) {
  const state = yield* writer
    .select()
    .from(UsageRollupStateTable)
    .where(and(eq(UsageRollupStateTable.id, 1), isNull(UsageRollupStateTable.time_backfilled)))
    .get()
    .pipe(Effect.orDie)
  if (!state) return { rows: 0, skipped: true, ms: 0 }
  const start = Date.now()
  const last =
    (yield* reader
      .select({ rowid: sql<number>`max(rowid)` })
      .from(MessageTable)
      .get()
      .pipe(Effect.orDie))?.rowid ?? 0
  // Each chunk holds a reader worker for well under a second, so foreground reads queued on the same worker
  // wait for one chunk rather than a whole-history scan.
  const totals = new Map<string, typeof UsageHourlyTable.$inferInsert>()
  for (let from = 0; from < last; from += chunkSize) {
    const chunk = yield* reader
      .select({
        hour: sql<number>`${MessageTable.time_created} / ${HOUR}`,
        session_id: MessageTable.session_id,
        provider_id: sql<string>`coalesce(json_extract(${MessageTable.data}, '$.providerID'), 'unknown')`,
        model_id: sql<string>`coalesce(json_extract(${MessageTable.data}, '$.modelID'), 'unknown')`,
        cost: sql<number>`coalesce(sum(json_extract(${MessageTable.data}, '$.cost')), 0)`,
        tokens_input: sql<number>`coalesce(sum(json_extract(${MessageTable.data}, '$.tokens.input')), 0)`,
        tokens_output: sql<number>`coalesce(sum(json_extract(${MessageTable.data}, '$.tokens.output')), 0)`,
        tokens_reasoning: sql<number>`coalesce(sum(json_extract(${MessageTable.data}, '$.tokens.reasoning')), 0)`,
        tokens_cache_read: sql<number>`coalesce(sum(json_extract(${MessageTable.data}, '$.tokens.cache.read')), 0)`,
        tokens_cache_write: sql<number>`coalesce(sum(json_extract(${MessageTable.data}, '$.tokens.cache.write')), 0)`,
      })
      .from(MessageTable)
      .where(
        and(
          sql`rowid > ${from} and rowid <= ${from + chunkSize}`,
          lt(MessageTable.time_created, state.cutoff),
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        ),
      )
      .groupBy(sql`1`, sql`2`, sql`3`, sql`4`)
      .all()
      .pipe(Effect.orDie)
    for (const row of chunk) {
      const key = `${row.hour}\u0000${row.session_id}\u0000${row.provider_id}\u0000${row.model_id}`
      const total = totals.get(key)
      if (!total) {
        totals.set(key, row)
        continue
      }
      total.cost = (total.cost ?? 0) + row.cost
      total.tokens_input = (total.tokens_input ?? 0) + row.tokens_input
      total.tokens_output = (total.tokens_output ?? 0) + row.tokens_output
      total.tokens_reasoning = (total.tokens_reasoning ?? 0) + row.tokens_reasoning
      total.tokens_cache_read = (total.tokens_cache_read ?? 0) + row.tokens_cache_read
      total.tokens_cache_write = (total.tokens_cache_write ?? 0) + row.tokens_cache_write
    }
    yield* Effect.sleep(BACKFILL_PAUSE)
  }
  const rows = [...totals.values()]
  // Statements on `writer` inside the transaction effect run in that transaction.
  yield* writer.transaction(() =>
    Effect.gen(function* () {
      const marked = yield* writer
        .update(UsageRollupStateTable)
        .set({ time_backfilled: Date.now() })
        .where(and(eq(UsageRollupStateTable.id, 1), isNull(UsageRollupStateTable.time_backfilled)))
        .returning({ id: UsageRollupStateTable.id })
        .all()
      // Another backfill finished first; its rows are already in.
      if (marked.length === 0) return
      yield* add(writer, rows)
    }),
  ).pipe(Effect.orDie)
  return { rows: rows.length, skipped: false, ms: Date.now() - start }
})

/**
 * Estimated spend per local day for the last `days` days (today included), newest first. `offsetMinutes` is
 * the local offset from UTC (east positive); local days are built from UTC hours, so half-hour zones round
 * to the hour.
 */
/** Whether the price source has a rate for a model; `daily` falls back to "has cost" when none is given. */
export type RateLookup = (provider: string, model: string) => boolean

export const daily = Effect.fn("UsageRollup.daily")(function* (
  db: Db,
  input: { days: number; offsetMinutes: number; now?: number; hasRate?: RateLookup; isLocal?: (provider: string) => boolean },
) {
  const now = input.now ?? Date.now()
  const shift = Math.round(input.offsetMinutes / 60)
  const today = Math.floor((now / HOUR + shift) / 24)
  const first = today - input.days + 1
  const rows = yield* db
    .select({
      day: sql<number>`(${UsageHourlyTable.hour} + ${shift}) / 24`,
      provider: UsageHourlyTable.provider_id,
      model: UsageHourlyTable.model_id,
      cost: sql<number>`sum(${UsageHourlyTable.cost})`,
      input: sql<number>`sum(${UsageHourlyTable.tokens_input})`,
      output: sql<number>`sum(${UsageHourlyTable.tokens_output})`,
      reasoning: sql<number>`sum(${UsageHourlyTable.tokens_reasoning})`,
      cacheRead: sql<number>`sum(${UsageHourlyTable.tokens_cache_read})`,
      cacheWrite: sql<number>`sum(${UsageHourlyTable.tokens_cache_write})`,
    })
    .from(UsageHourlyTable)
    .where(gte(UsageHourlyTable.hour, first * 24 - shift))
    .groupBy(sql`1`, UsageHourlyTable.provider_id, UsageHourlyTable.model_id)
    .all()
    .pipe(Effect.orDie)
  const state = yield* db.select().from(UsageRollupStateTable).where(eq(UsageRollupStateTable.id, 1)).get().pipe(Effect.orDie)
  const backfilled = state?.time_backfilled !== null && state?.time_backfilled !== undefined
  const days = Array.from({ length: input.days }, (_, index) => today - index).map((day) => {
    const models = rows
      .filter((row) => row.day === day)
      .map((row) => {
        const tokens = row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
        const priced = input.hasRate ? input.hasRate(row.provider, row.model) : row.cost !== 0
        // Models served on this machine have no API bill; that is distinct from a billed model with no known rate.
        const coverage: "priced" | "missing-rate" | "local" | "no-usage" =
          tokens === 0 ? "no-usage" : priced ? "priced" : input.isLocal?.(row.provider) ? "local" : "missing-rate"
        return {
          provider: row.provider,
          model: row.model,
          // Unknown, not zero, when the price source has no rate for the model; local models are not billed.
          cost: coverage === "missing-rate" ? null : coverage === "local" ? 0 : round(row.cost),
          coverage,
          tokens: { input: row.input, output: row.output, reasoning: row.reasoning, cache: { read: row.cacheRead, write: row.cacheWrite } },
        }
      })
      .toSorted((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
    const unpriced = models.filter((model) => model.coverage === "missing-rate")
    // Days before the live cutoff are only known once the backfill has run.
    const live = (day * 24 - shift) * HOUR >= (state?.cutoff ?? Infinity)
    const complete = backfilled || live
    // Sum of priced models only; unpriced usage is reported beside it, never folded in as $0.
    const cost = complete ? round(models.reduce((total, model) => total + (model.cost ?? 0), 0)) : null
    return {
      day: new Date(day * 24 * HOUR).toISOString().slice(0, 10),
      complete,
      cost,
      // The whole day is after originSince: every step counted here ran on this host and no other host counts it,
      // so originCost from several hosts can be summed. Earlier days include backfilled history that may also
      // be counted on the host it was moved from.
      originOnly: live,
      originCost: live ? cost : null,
      unpricedModels: unpriced.length,
      unpricedTokens: unpriced.reduce(
        (total, model) =>
          total + model.tokens.input + model.tokens.output + model.tokens.reasoning + model.tokens.cache.read + model.tokens.cache.write,
        0,
      ),
      models,
    }
  })
  return {
    estimate: true as const,
    basis: "local estimate: stored token counts priced by the local model catalog; not provider billing",
    host: os.hostname(),
    observedAt: new Date(now).toISOString(),
    offsetMinutes: shift * 60,
    coverage: {
      scope: "assistant messages that ran on this host (all sessions and directories in this database)",
      liveSince: state ? new Date(state.cutoff).toISOString() : undefined,
      backfilled,
      origin: {
        basis: "originating-host-only from originSince: a step counts on the host whose runner produced it; replayed, synced and moved sessions are not counted",
        hostID: os.hostname(),
        originSince: state ? new Date(state.cutoff).toISOString() : undefined,
      },
    },
    notes: [
      "cost is null for days not yet covered (history before liveSince until the one-time backfill finishes)",
      "models with coverage=missing-rate used tokens the price source has no rate for: cost null (unknown, not zero); day cost sums priced models only and unpricedModels/unpricedTokens report the rest. coverage=local: a provider served from this machine (loopback endpoint), no API bill",
      "steps that ran on this host count; synced or moved sessions are skipped from liveSince on, but history before liveSince is counted from every local message, so history moved from another host can also count there",
      "local days are built from UTC hours: zones with a 30 or 45 minute offset are rounded to the hour",
      "to total several hosts, sum days[].originCost and treat any day with originOnly=false (or an unreachable host) as partial; the sum is still an estimate, not billing",
      "not provider billing",
    ],
    days,
  }
})

/**
 * Sessions by estimated spend over the last `days` local days (today included). A session's cost is null when any
 * of its usage in the window is on a billed model with no known rate (unknown, not partially summed).
 */
export const sessions = Effect.fn("UsageRollup.sessions")(function* (
  db: Db,
  input: { days: number; offsetMinutes: number; limit: number; now?: number; hasRate?: RateLookup; isLocal?: (provider: string) => boolean },
) {
  const now = input.now ?? Date.now()
  const shift = Math.round(input.offsetMinutes / 60)
  const today = Math.floor((now / HOUR + shift) / 24)
  const since = (today - input.days + 1) * 24 - shift
  const rows = yield* db
    .select({
      sessionID: UsageHourlyTable.session_id,
      provider: UsageHourlyTable.provider_id,
      model: UsageHourlyTable.model_id,
      cost: sql<number>`sum(${UsageHourlyTable.cost})`,
      input: sql<number>`sum(${UsageHourlyTable.tokens_input})`,
      output: sql<number>`sum(${UsageHourlyTable.tokens_output})`,
      reasoning: sql<number>`sum(${UsageHourlyTable.tokens_reasoning})`,
      cacheRead: sql<number>`sum(${UsageHourlyTable.tokens_cache_read})`,
      cacheWrite: sql<number>`sum(${UsageHourlyTable.tokens_cache_write})`,
      lastHour: sql<number>`max(${UsageHourlyTable.hour})`,
    })
    .from(UsageHourlyTable)
    .where(gte(UsageHourlyTable.hour, since))
    .groupBy(UsageHourlyTable.session_id, UsageHourlyTable.provider_id, UsageHourlyTable.model_id)
    .all()
    .pipe(Effect.orDie)
  const totals = new Map<string, { cost: number; unknown: boolean; unpricedTokens: number; tokens: Usage["tokens"]; lastHour: number }>()
  for (const row of rows) {
    const tokens = row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
    const priced = input.hasRate ? input.hasRate(row.provider, row.model) : row.cost !== 0
    const missing = tokens > 0 && !priced && !input.isLocal?.(row.provider)
    const total = totals.get(row.sessionID) ?? {
      cost: 0,
      unknown: false,
      unpricedTokens: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      lastHour: 0,
    }
    if (missing) {
      total.unknown = true
      total.unpricedTokens += tokens
    }
    if (priced) total.cost += row.cost
    total.tokens.input += row.input
    total.tokens.output += row.output
    total.tokens.reasoning += row.reasoning
    total.tokens.cache.read += row.cacheRead
    total.tokens.cache.write += row.cacheWrite
    total.lastHour = Math.max(total.lastHour, row.lastHour)
    totals.set(row.sessionID, total)
  }
  const top = [...totals]
    .filter(([, total]) => total.cost !== 0 || total.unpricedTokens !== 0 || totalTokens(total.tokens) !== 0)
    .toSorted((a, b) => b[1].cost - a[1].cost || b[1].unpricedTokens - a[1].unpricedTokens)
    .slice(0, input.limit)
  const info = top.length
    ? yield* db
        .select({ id: SessionTable.id, title: SessionTable.title, directory: SessionTable.directory, parentID: SessionTable.parent_id, updated: SessionTable.time_updated })
        .from(SessionTable)
        .where(inArray(SessionTable.id, top.map(([id]) => id) as never[]))
        .all()
        .pipe(Effect.orDie)
    : []
  const byID = new Map(info.map((row) => [row.id as string, row]))
  const state = yield* db.select().from(UsageRollupStateTable).where(eq(UsageRollupStateTable.id, 1)).get().pipe(Effect.orDie)
  return {
    estimate: true as const,
    basis: "local estimate: stored token counts priced by the local model catalog; not provider billing",
    host: os.hostname(),
    observedAt: new Date(now).toISOString(),
    offsetMinutes: shift * 60,
    coverage: {
      since: new Date(since * HOUR).toISOString(),
      backfilled: state?.time_backfilled !== null && state?.time_backfilled !== undefined,
      liveSince: state ? new Date(state.cutoff).toISOString() : undefined,
    },
    sessions: top.map(([sessionID, total]) => {
      const row = byID.get(sessionID)
      return {
        sessionID,
        parentID: row?.parentID ?? undefined,
        title: row?.title ?? undefined,
        directory: row?.directory ?? undefined,
        cost: total.unknown ? null : round(total.cost),
        pricedCost: round(total.cost),
        unpricedTokens: total.unpricedTokens,
        tokens: total.tokens,
        // Hour of the session's most recent counted usage.
        lastActive: new Date((total.lastHour + 1) * HOUR - 1).toISOString(),
      }
    }),
  }
})

const add = (db: Db, rows: (typeof UsageHourlyTable.$inferInsert)[]) =>
  Effect.forEach(
    rows,
    (row) =>
      db
        .insert(UsageHourlyTable)
        .values(row)
        .onConflictDoUpdate({
          target: [UsageHourlyTable.hour, UsageHourlyTable.session_id, UsageHourlyTable.provider_id, UsageHourlyTable.model_id],
          set: {
            cost: sql`${UsageHourlyTable.cost} + excluded.cost`,
            tokens_input: sql`${UsageHourlyTable.tokens_input} + excluded.tokens_input`,
            tokens_output: sql`${UsageHourlyTable.tokens_output} + excluded.tokens_output`,
            tokens_reasoning: sql`${UsageHourlyTable.tokens_reasoning} + excluded.tokens_reasoning`,
            tokens_cache_read: sql`${UsageHourlyTable.tokens_cache_read} + excluded.tokens_cache_read`,
            tokens_cache_write: sql`${UsageHourlyTable.tokens_cache_write} + excluded.tokens_cache_write`,
          },
        })
        .run()
        .pipe(Effect.orDie),
    { discard: true },
  )

function totalTokens(tokens: Usage["tokens"]) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function round(value: number) {
  return Math.round(value * 1e6) / 1e6
}

export interface Interface {
  readonly daily: (input: {
    days: number
    offsetMinutes: number
    hasRate?: RateLookup
    isLocal?: (provider: string) => boolean
  }) => Effect.Effect<Effect.Success<ReturnType<typeof daily>>>
  readonly sessions: (input: SessionsInput) => Effect.Effect<Effect.Success<ReturnType<typeof sessions>>>
}

export type SessionsInput = { days: number; offsetMinutes: number; limit: number; hasRate?: RateLookup; isLocal?: (provider: string) => boolean }

export class Service extends Context.Service<Service, Interface>()("@opencode/UsageRollup") {}

// Startup is busy (first history loads); the backfill aggregate reads the whole message table on a reader worker.
const BACKFILL_DELAY = "60 seconds"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const writer = yield* Database.Service
    const reader = yield* DatabaseReader.Service
    yield* backfill(writer.db, reader.db).pipe(
      Effect.tap((result) => (result.skipped ? Effect.void : Effect.logInfo("usage rollup backfilled", result))),
      Effect.catchCause((cause) => Effect.logError("usage rollup backfill failed", { cause: Cause.pretty(cause) })),
      Effect.delay(BACKFILL_DELAY),
      Effect.forkScoped,
    )
    return Service.of({ daily: (input) => daily(reader.db, input), sessions: (input) => sessions(reader.db, input) })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, DatabaseReader.node] })

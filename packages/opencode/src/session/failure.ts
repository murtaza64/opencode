import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionSupersessionTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { MessageV2 } from "./message-v2"
import { MessageID, SessionID } from "./schema"

// Only metadata leaves Core: provider error messages, bodies and headers can carry secrets.
export const ErrorSummary = Schema.Struct({
  name: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "SessionFailureError" })

export const Info = Schema.Struct({
  sessionID: SessionID,
  directory: Schema.String,
  messageID: MessageID,
  parentID: MessageID,
  time: NonNegativeInt,
  error: ErrorSummary,
  retry: Schema.Literals(["available", "unsafe", "out-of-order"]),
}).annotate({ identifier: "SessionFailure" })
export type Info = typeof Info.Type

export const Outcome = Schema.Literals([
  "accepted",
  "running",
  "stale",
  "not-failed",
  "unsafe",
  "waiting",
  "archived",
  "child",
  "superseded",
  "mismatch",
])
export type Outcome = typeof Outcome.Type

export const RetryPayload = Schema.Struct({ messageID: MessageID }).annotate({ identifier: "SessionRetryInput" })

export const RetryResult = Schema.Struct({
  outcome: Outcome,
  failed: Schema.optional(Info),
}).annotate({ identifier: "SessionRetryResult" })
export type RetryResult = typeof RetryResult.Type

/**
 * A Session failed mid-turn when its newest durable message is an assistant step that ended in a
 * non-abort error. Retry stays available only when that step ran no tools: the model history drops
 * errored steps, so a replay would hide any tool effect the step already caused. A step stamped after
 * `now` (imported history, clock corrected backwards) is out of order: every row a retry writes would
 * sort before it, so the retried turn could never observe its own progress.
 */
export function inspect(
  session: { id: SessionID; directory: string },
  latest: SessionV1.WithParts | undefined,
  now: number,
): Info | undefined {
  if (!latest || latest.info.role !== "assistant") return
  const error = latest.info.error
  if (!error || error.name === "MessageAbortedError") return
  return {
    sessionID: session.id,
    directory: session.directory,
    messageID: latest.info.id,
    parentID: latest.info.parentID,
    time: latest.info.time.completed ?? latest.info.time.created,
    error: error.name === "APIError" && error.data.statusCode !== undefined
      ? { name: error.name, statusCode: error.data.statusCode }
      : { name: error.name },
    retry: latest.parts.some((part) => part.type === "tool")
      ? "unsafe"
      : latest.info.time.created > now
        ? "out-of-order"
        : "available",
  }
}

/**
 * Newest message by insertion. SQLite gives every inserted row a rowid above all existing rows, so unlike
 * time_created this order survives imported timestamps and clock corrections. Upserts keep their rowid,
 * and Core never runs VACUUM, the one operation that may renumber rowids of this text-keyed table.
 */
export const lastInserted = Effect.fn("SessionFailure.lastInserted")(function* (sessionID: SessionID) {
  const database = yield* Database.Service
  const row = yield* database.db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row?.id
})

/**
 * Unarchived, unreverted root Sessions without a handoff fence whose newest message is a failed step.
 * Newest must hold by both time and insertion: a row written after the failed step (a retry, a prompt)
 * means the Session moved on even when that row's timestamp sorts earlier.
 */
export const list = Effect.fn("SessionFailure.list")(function* () {
  const database = yield* Database.Service
  // Correlated newest-row lookup walks message_session_time_created_id_idx once per root.
  const newest = sql`(select ${sql.identifier("id")} from ${MessageTable} where ${sql.identifier("session_id")} = ${SessionTable.id} order by ${sql.identifier("time_created")} desc, ${sql.identifier("id")} desc limit 1)`
  const candidates = yield* database.db
    .select({ id: SessionTable.id, directory: SessionTable.directory })
    .from(SessionTable)
    .innerJoin(MessageTable, eq(MessageTable.id, newest))
    .leftJoin(SessionSupersessionTable, eq(SessionSupersessionTable.session_id, SessionTable.id))
    .where(
      and(
        isNull(SessionTable.parent_id),
        isNull(SessionTable.time_archived),
        isNull(SessionTable.revert),
        isNull(SessionSupersessionTable.session_id),
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        sql`json_extract(${MessageTable.data}, '$.error.name') is not null`,
        sql`json_extract(${MessageTable.data}, '$.error.name') != 'MessageAbortedError'`,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const now = Date.now()
  const failures = yield* Effect.forEach(
    candidates,
    (session) =>
      Effect.gen(function* () {
        const latest = (yield* MessageV2.page({ sessionID: session.id, limit: 1 })).items.at(-1)
        if (latest?.info.id !== (yield* lastInserted(session.id))) return
        return inspect(session, latest, now)
      }).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined))),
    { concurrency: 4 },
  )
  return failures.filter((item): item is Info => item !== undefined).toSorted((a, b) => b.time - a.time)
})

export * as SessionFailure from "./failure"

import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageTable,
  SessionSupersessionTable,
  SessionTable,
  V1InputTable,
} from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Schedule } from "effect"
import { SessionRunState } from "./run-state"
import { fromRow } from "./session"
import { SessionID } from "./schema"

/**
 * A root Session is archived after this long without durable activity anywhere in its subagent tree. Archiving only
 * sets `time.archived`; history stays, and restoring (`time.archived: null`) counts as fresh activity.
 *
 * Retention runs on the server and cannot see client-local sidebar pins: a pinned Session idle this long is archived
 * like any other and leaves the pinned list until restored. Exclusion of in-flight work is authoritative only for this
 * process (V1 run state and V2 local execution); another process sharing the database is covered by the durable gates
 * alone. Work started on a Session after it was archived, such as a prompt sent to an open archived Session, does not
 * restore it.
 */
export const IDLE = Duration.days(7)
/** Let restart recovery settle before the first sweep of a process. */
export const STARTUP_DELAY = Duration.minutes(10)
export const INTERVAL = Duration.hours(1)
/** Candidates inspected per page; each holds the event loop for a few milliseconds of synchronous SQLite reads. */
export const PAGE = 8
/** Pause between pages so a large first backlog never monopolizes the server's event loop. */
export const PAUSE = Duration.millis(10)

export type Blocker = "running" | "compacting" | "turn" | "tool" | "input" | "handoff"

export type Verdict =
  | { readonly type: "eligible"; readonly activity: number }
  | { readonly type: "recent"; readonly activity: number }
  | { readonly type: "blocked"; readonly sessionID: SessionID; readonly blocker: Blocker }
  | { readonly type: "skipped" }

export interface Interface {
  /** Archive every eligible root once; returns the archived Session IDs. Safe to run concurrently and repeatedly. */
  readonly sweep: () => Effect.Effect<SessionID[]>
  /** Evaluate one root without writing. */
  readonly inspect: (sessionID: SessionID, now: number) => Effect.Effect<Verdict>
  /** Archive one root if it is eligible at the commit point; returns whether this call archived it. */
  readonly archive: (sessionID: SessionID, now: number) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRetention") {}

class Ineligible extends Error {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const inspectTree = Effect.fn("SessionRetention.inspectTree")(function* (sessionID: SessionID, now: number) {
      const facts = yield* Effect.forEach(yield* tree(sessionID), observe)
      const blocked = facts.find((fact) => fact.blocker !== undefined)
      if (blocked?.blocker) return { type: "blocked", sessionID: blocked.sessionID, blocker: blocked.blocker } as const
      const activity = Math.max(...facts.map((fact) => fact.activity))
      if (activity > now - Duration.toMillis(IDLE)) return { type: "recent", activity } as const
      return { type: "eligible", activity } as const
    })

    const inspect = Effect.fn("SessionRetention.inspect")(function* (sessionID: SessionID, now: number) {
      const root = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!root || root.parent_id !== null || root.time_archived !== null) return { type: "skipped" } as const
      return yield* inspectTree(sessionID, now)
    })

    /**
     * Publish through the durable event's commit hook, which runs inside the event's immediate transaction after
     * projection and before any listener, bus, or SSE notification. The hook rejects unless the root aggregate is
     * still at the sequence read here (so no prompt, manual archive, restore, or other root event interleaved) and the
     * whole tree is still eligible. A rejection rolls the projection back and nothing is announced.
     */
    const archive = Effect.fn("SessionRetention.archive")(function* (sessionID: SessionID, now: number) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!row || row.parent_id !== null || row.time_archived !== null) return false
      const expected = yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const info = fromRow(row)
      return yield* events
        .publish(
          SessionV1.Event.Updated,
          { sessionID, info: { ...info, time: { ...info.time, archived: now } } },
          {
            location: {
              directory: AbsolutePath.make(row.directory),
              ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
            },
            commit: (seq) =>
              Effect.gen(function* () {
                if (seq !== (expected?.seq ?? -1) + 1) return yield* Effect.die(new Ineligible())
                if ((yield* inspectTree(sessionID, now)).type !== "eligible") return yield* Effect.die(new Ineligible())
              }),
          },
        )
        .pipe(
          Effect.as(true),
          Effect.catchDefect((defect) => (defect instanceof Ineligible ? Effect.succeed(false) : Effect.die(defect))),
        )
    })

    const sweep = Effect.fn("SessionRetention.sweep")(function* () {
      const now = yield* Clock.currentTimeMillis
      const cutoff = now - Duration.toMillis(IDLE)
      // Root time_updated never exceeds the tree's activity, so it bounds candidates before any message lookup.
      // Keyset pages keep each read and each burst of inspections small however large the backlog is.
      const page = (after?: { updated: number; id: SessionID }) =>
        db
          .select({ id: SessionTable.id, updated: SessionTable.time_updated })
          .from(SessionTable)
          .where(
            and(
              isNull(SessionTable.parent_id),
              isNull(SessionTable.time_archived),
              lte(SessionTable.time_updated, cutoff),
              after
                ? or(
                    gt(SessionTable.time_updated, after.updated),
                    and(eq(SessionTable.time_updated, after.updated), gt(SessionTable.id, after.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(SessionTable.time_updated), asc(SessionTable.id))
          .limit(PAGE)
          .all()
          .pipe(Effect.orDie)
      const archived: SessionID[] = []
      let candidates = yield* page()
      while (candidates.length) {
        for (const candidate of candidates) {
          if ((yield* inspect(candidate.id, now)).type !== "eligible") continue
          if (yield* archive(candidate.id, now)) archived.push(candidate.id)
        }
        if (candidates.length < PAGE) break
        yield* Effect.sleep(PAUSE)
        candidates = yield* page(candidates.at(-1))
      }
      if (archived.length) yield* Effect.logInfo("archived idle sessions", { count: archived.length })
      return archived
    })

    return Service.of({ sweep, inspect, archive })

    function tree(sessionID: SessionID) {
      return db
        .all<{ id: SessionID }>(
          sql`with recursive tree(id) as (select ${sessionID} union select ${SessionTable.id} from ${SessionTable} join tree on ${SessionTable.parent_id} = tree.id) select id from tree`,
        )
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.id)),
        )
    }

    function observe(sessionID: SessionID) {
      return Effect.gen(function* () {
        const session = yield* db
          .select({
            updated: SessionTable.time_updated,
            compacting: SessionTable.time_compacting,
            handoff: SessionSupersessionTable.state,
          })
          .from(SessionTable)
          .leftJoin(SessionSupersessionTable, eq(SessionSupersessionTable.session_id, SessionTable.id))
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const v1 = yield* db
          .select({ id: MessageTable.id, time: MessageTable.time_created, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const v1Tool = v1
          ? yield* db
              .select({ id: PartTable.id })
              .from(PartTable)
              .where(
                and(
                  eq(PartTable.message_id, v1.id),
                  sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
                  sql`json_extract(${PartTable.data}, '$.state.status') in ('pending', 'running')`,
                ),
              )
              .limit(1)
              .get()
              .pipe(Effect.orDie)
          : undefined
        const v2 = yield* db
          .select({ type: SessionMessageTable.type, data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const v2Time = yield* db
          .select({ time: SessionMessageTable.time_created })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(desc(SessionMessageTable.time_created), desc(SessionMessageTable.id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const v1Input = yield* db
          .select({ id: V1InputTable.request_id })
          .from(V1InputTable)
          .where(
            and(
              eq(V1InputTable.session_id, sessionID),
              sql`(${V1InputTable.state} = 'pending' or (${V1InputTable.state} = 'promoted' and json_extract(${V1InputTable.payload}, '$.source.type') = 'editspace-mail' and json_extract(${V1InputTable.receipt}, '$.timeHandled') is null))`,
            ),
          )
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const v2Input = yield* db
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(and(eq(SessionInputTable.session_id, sessionID), isNull(SessionInputTable.promoted_seq)))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        // A step's row is stamped when it starts; its completion time also counts.
        const activity = Math.max(
          session?.updated ?? 0,
          v1?.time ?? 0,
          completedAt(v1?.data),
          v2Time?.time ?? 0,
          completedAt(v2?.data),
        )
        const blocker: Blocker | undefined =
          SessionRunState.isActive(sessionID) || SessionExecutionLocal.isActive(sessionID)
            ? "running"
            : session?.compacting
              ? "compacting"
              : session?.handoff === "pending"
                ? "handoff"
                : v1Input || v2Input
                  ? "input"
                  : v1Tool || unsettledV2Tool(v2)
                    ? "tool"
                    : unfinishedV1(v1?.data) || unfinishedV2(v2)
                      ? "turn"
                      : undefined
        return { sessionID, activity, blocker }
      })
    }
  }),
)

function completedAt(data: unknown) {
  const completed = (data as { time?: { completed?: unknown } } | undefined)?.time?.completed
  return typeof completed === "number" ? completed : 0
}

/**
 * A V1 Session still owes work when its newest message is an unanswered prompt or an assistant step that has not
 * completed (running, awaiting a permission or question, or cut off by a restart) or that completed asking for a
 * continuation. A completed failed step whose
 * tools all settled is inactive: retry stays available after archive, and nothing is left running.
 */
function unfinishedV1(data: (typeof MessageTable.$inferSelect)["data"] | undefined) {
  if (!data) return false
  if (data.role === "user") return true
  // Omit over the role union defeats narrowing; the remaining role is assistant.
  return unfinishedStep(data as { time: { completed?: unknown }; error?: unknown; finish?: string; structured?: unknown })
}

/** A completed step that asked for tool results or ended unknown still owes a continuation. */
function unfinishedStep(step: { time?: { completed?: unknown }; error?: unknown; finish?: string; structured?: unknown }) {
  if (step.time?.completed === undefined) return true
  if (step.error !== undefined || step.structured !== undefined) return false
  return !step.finish || step.finish === "tool-calls" || step.finish === "unknown"
}

/** The V2 equivalent, ordered by aggregate sequence; a shell command counts as a turn until it completes. */
function unfinishedV2(row: Pick<typeof SessionMessageTable.$inferSelect, "type" | "data"> | undefined) {
  if (!row) return false
  if (row.type === "user") return true
  if (row.type === "shell") return (row.data as { time?: { completed?: unknown } }).time?.completed === undefined
  if (row.type !== "assistant") return false
  return unfinishedStep(row.data as { time?: { completed?: unknown }; error?: unknown; finish?: string })
}

/** A V2 tool call in the newest assistant message that never settled may still have effects in flight. */
function unsettledV2Tool(row: Pick<typeof SessionMessageTable.$inferSelect, "type" | "data"> | undefined) {
  if (row?.type !== "assistant") return false
  const content = (row.data as { content?: { type?: string; state?: { status?: string } }[] }).content ?? []
  return content.some((item) => item.type === "tool" && (item.state?.status === "pending" || item.state?.status === "running"))
}

/** Runs the sweep once per server process rather than once per active Location. */
const scheduleLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const retention = yield* Service
    yield* retention.sweep().pipe(
      Effect.catchCause((cause) => Effect.logError("session retention sweep failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(INTERVAL)),
      Effect.delay(STARTUP_DELAY),
      Effect.forkScoped,
    )
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.provideMerge(scheduleLayer, layer),
  deps: [Database.node, EventV2.node],
})

export * as SessionRetention from "./retention"

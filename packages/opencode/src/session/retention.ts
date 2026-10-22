import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  MessageTable,
  SessionInputTable,
  SessionMessageTable,
  SessionSupersessionTable,
  SessionTable,
  V1InputTable,
} from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Schedule, Stream } from "effect"
import { fromRow } from "./session"
import { SessionID } from "./schema"

/** A root Session is archived after this long without durable activity anywhere in its subagent tree. */
export const IDLE = Duration.days(7)
/** Let restart recovery settle and the status observer warm up before the first sweep of a process. */
export const STARTUP_DELAY = Duration.minutes(10)
export const INTERVAL = Duration.hours(1)

export type Blocker = "running" | "compacting" | "turn" | "input" | "handoff"

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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRetention") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    // Process-local busy/retry Sessions. Other processes sharing the database are covered by the durable
    // unfinished-turn gate: every running V1 or V2 turn keeps an incomplete assistant message.
    const running = new Set<string>()
    yield* events.subscribe(SessionStatusEvent.Status).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.data.status.type === "idle") running.delete(event.data.sessionID)
          else running.add(event.data.sessionID)
        }),
      ),
      Effect.forkScoped,
    )

    const inspect = Effect.fn("SessionRetention.inspect")(function* (sessionID: SessionID, now: number) {
      const root = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!root || root.parent_id !== null || root.time_archived !== null) return { type: "skipped" } as const
      const members = yield* tree(sessionID)
      const facts = yield* Effect.forEach(members, (member) => observe(member, running))
      const blocked = facts.find((fact) => fact.blocker !== undefined)
      if (blocked?.blocker) return { type: "blocked", sessionID: blocked.sessionID, blocker: blocked.blocker } as const
      const activity = Math.max(...facts.map((fact) => fact.activity))
      if (activity > now - Duration.toMillis(IDLE)) return { type: "recent", activity } as const
      return { type: "eligible", activity } as const
    })

    // Recheck and write under one immediate transaction so a prompt, child turn, or manual archive that lands
    // after the cheap pass is observed before the write. The archive keeps time.updated: it is not activity.
    const archive = Effect.fn("SessionRetention.archive")(function* (sessionID: SessionID, now: number) {
      return yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              if ((yield* inspect(sessionID, now)).type !== "eligible") return false
              const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
              if (!row) return false
              const info = fromRow(row)
              yield* events.publish(
                SessionV1.Event.Updated,
                { sessionID, info: { ...info, time: { ...info.time, archived: now } } },
                {
                  location: {
                    directory: AbsolutePath.make(row.directory),
                    ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
                  },
                },
              )
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const sweep = Effect.fn("SessionRetention.sweep")(function* () {
      const now = yield* Clock.currentTimeMillis
      // Root time_updated never exceeds the tree's activity, so it bounds candidates before any message lookup.
      const candidates = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            isNull(SessionTable.parent_id),
            isNull(SessionTable.time_archived),
            lte(SessionTable.time_updated, now - Duration.toMillis(IDLE)),
          ),
        )
        .orderBy(asc(SessionTable.time_updated), asc(SessionTable.id))
        .all()
        .pipe(Effect.orDie)
      const archived = yield* Effect.forEach(candidates, (candidate) =>
        Effect.gen(function* () {
          if ((yield* inspect(candidate.id, now)).type !== "eligible") return []
          return (yield* archive(candidate.id, now)) ? [candidate.id] : []
        }),
      ).pipe(Effect.map((items) => items.flat()))
      if (archived.length) yield* Effect.logInfo("archived idle sessions", { count: archived.length })
      return archived
    })

    return Service.of({ sweep, inspect })

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

    function observe(sessionID: SessionID, active: ReadonlySet<string>) {
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
          .select({ time: MessageTable.time_created, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
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
        const blocker: Blocker | undefined = active.has(sessionID)
          ? "running"
          : session?.compacting
            ? "compacting"
            : session?.handoff === "pending"
              ? "handoff"
              : v1Input || v2Input
                ? "input"
                : unfinishedV1(v1?.data) || unfinishedV2(v2)
                  ? "turn"
                  : undefined
        return { sessionID, activity, blocker }
      })
    }
  }),
)

/**
 * A V1 Session still owes work when its newest message is an unanswered prompt, an assistant step that has not
 * completed (running, awaiting a permission or question, or cut off by a restart), or a failed step awaiting retry.
 */
function unfinishedV1(data: (typeof MessageTable.$inferSelect)["data"] | undefined) {
  if (!data) return false
  if (data.role === "user") return true
  // Omit over the role union defeats narrowing; the remaining role is assistant.
  const assistant = data as { time: { completed?: number }; error?: { name: string } }
  if (assistant.time.completed === undefined) return true
  return assistant.error !== undefined && assistant.error.name !== "MessageAbortedError"
}

function completedAt(data: unknown) {
  const completed = (data as { time?: { completed?: unknown } } | undefined)?.time?.completed
  return typeof completed === "number" ? completed : 0
}

/** The V2 equivalent, ordered by aggregate sequence; a shell command counts as a turn until it completes. */
function unfinishedV2(row: Pick<typeof SessionMessageTable.$inferSelect, "type" | "data"> | undefined) {
  if (!row) return false
  if (row.type === "user") return true
  if (row.type !== "assistant" && row.type !== "shell") return false
  const data = row.data as { time?: { completed?: unknown }; error?: unknown }
  return data.time?.completed === undefined || (row.type === "assistant" && data.error !== undefined)
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

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionSupersessionTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Context, Effect, Layer, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { SessionID } from "./schema"
import { InstanceState } from "@/effect/instance-state"

export const Receipt = Schema.Struct({
  sessionID: SessionID,
  successor: SessionID,
  state: Schema.Literals(["pending", "committed"]),
})
export type Receipt = typeof Receipt.Type
/** Where the successor may live; cross-directory is an explicit owner-handoff opt-in. */
export type Scope = "same-directory" | "cross-directory"

export class Closed extends Schema.TaggedErrorClass<Closed>()("SessionSuperseded", {
  sessionID: SessionID,
  successor: SessionID,
  state: Schema.Literals(["pending", "committed"]),
}) {}

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("SessionSupersessionInvalid", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Receipt | undefined>
  readonly request: (sessionID: SessionID, successor: SessionID, scope?: Scope) => Effect.Effect<Receipt, Invalid | Closed>
  readonly commit: (sessionID: SessionID) => Effect.Effect<Receipt | undefined>
  /** Drops a pending fence so the predecessor reopens; a committed fence is final and fails Closed. */
  readonly cancel: (sessionID: SessionID) => Effect.Effect<Receipt | undefined, Closed>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSupersession") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const get = Effect.fn("SessionSupersession.get")(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionSupersessionTable)
        .where(eq(SessionSupersessionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return { sessionID, successor: row.successor_id, state: row.state } satisfies Receipt
    })
    const request = Effect.fn("SessionSupersession.request")(function* (
      sessionID: SessionID,
      successor: SessionID,
      scope: Scope = "same-directory",
    ) {
      const context = yield* InstanceState.context
      const existing = yield* get(sessionID)
      if (existing) {
        if (existing.successor !== successor) return yield* new Closed(existing)
        return existing
      }
      if (sessionID === successor) return yield* new Invalid({ message: "Successor must differ from predecessor" })
      const [source, target] = yield* Effect.all(
        [
          db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
          db.select().from(SessionTable).where(eq(SessionTable.id, successor)).get(),
        ],
        { concurrency: 2 },
      ).pipe(Effect.orDie)
      // The fence only closes the routed source; it never runs, moves or rehomes anything in the target.
      if (!source || !FSUtil.sameDirectory(source.directory, context.directory))
        return yield* new Invalid({ message: "Session must belong to the routed directory" })
      if (scope === "cross-directory") {
        if (!target || target.parent_id || target.time_archived)
          return yield* new Invalid({ message: "Successor must be an existing, unarchived top-level session" })
      } else if (!target || source.project_id !== target.project_id || !FSUtil.sameDirectory(source.directory, target.directory))
        return yield* new Invalid({ message: "Successor must exist in the same project and directory" })
      yield* db
        .insert(SessionSupersessionTable)
        .values({ session_id: sessionID, successor_id: successor, state: "pending" })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const current = yield* get(sessionID)
      if (!current) return yield* Effect.die("Supersession request was not stored")
      if (current.successor !== successor) return yield* new Closed(current)
      return current
    })
    const commit = Effect.fn("SessionSupersession.commit")(function* (sessionID: SessionID) {
      yield* db
        .update(SessionSupersessionTable)
        .set({ state: "committed", time_committed: Date.now() })
        .where(and(eq(SessionSupersessionTable.session_id, sessionID), eq(SessionSupersessionTable.state, "pending")))
        .run()
        .pipe(Effect.orDie)
      return yield* get(sessionID)
    })
    const cancel = Effect.fn("SessionSupersession.cancel")(function* (sessionID: SessionID) {
      const existing = yield* get(sessionID)
      if (!existing) return undefined
      if (existing.state === "committed") return yield* new Closed(existing)
      yield* db
        .delete(SessionSupersessionTable)
        .where(and(eq(SessionSupersessionTable.session_id, sessionID), eq(SessionSupersessionTable.state, "pending")))
        .run()
        .pipe(Effect.orDie)
      const current = yield* get(sessionID)
      // A drain settling between the read and the delete may have committed it.
      if (current) return yield* new Closed(current)
      return existing
    })
    return Service.of({ get, request, commit, cancel })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as SessionSupersession from "./supersession"

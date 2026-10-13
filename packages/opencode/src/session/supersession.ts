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
  readonly request: (sessionID: SessionID, successor: SessionID) => Effect.Effect<Receipt, Invalid | Closed>
  readonly commit: (sessionID: SessionID) => Effect.Effect<Receipt | undefined>
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
    const request = Effect.fn("SessionSupersession.request")(function* (sessionID: SessionID, successor: SessionID) {
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
      if (
        !source ||
        !target ||
        source.directory !== context.directory ||
        source.project_id !== target.project_id ||
        source.directory !== target.directory
      )
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
    return Service.of({ get, request, commit })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as SessionSupersession from "./supersession"

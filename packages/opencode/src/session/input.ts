import { isDeepStrictEqual } from "node:util"
import { and, asc, eq, gt } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { V1InputTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "./session"
import { MessageID, PartID, SessionID } from "./schema"

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("InputConflict", { message: Schema.String }) {}
export class Missing extends Schema.TaggedErrorClass<Missing>()("InputMissing", { message: Schema.String }) {}
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("InputInvalid", { message: Schema.String }) {}

const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const db = database.db
  const reconcile = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.catchDefect((error) =>
        error instanceof SessionProjector.InputLifecycleConflict ? Effect.void : Effect.die(error),
      ),
    )

  const find = (requestID: string) =>
    db.select().from(V1InputTable).where(eq(V1InputTable.request_id, requestID)).get().pipe(Effect.orDie)

  const get = Effect.fn("SessionInput.get")(function* (sessionID: SessionID, requestID: string) {
    const row = yield* find(requestID)
    if (!row || row.session_id !== sessionID) return yield* new Missing({ message: "Input not found" })
    return row.receipt
  })

  const admit = Effect.fn("SessionInput.admit")(function* (sessionID: SessionID, payload: SessionV1.InputPayload) {
    const existing = yield* find(payload.requestID)
    if (existing) {
      if (existing.session_id !== sessionID || !isDeepStrictEqual(existing.payload, payload))
        return yield* new Conflict({ message: "requestID already used for a different input" })
      return existing.receipt
    }
    const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
    const previous = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user").pipe(Effect.orDie)
    const user = Option.isSome(previous) && previous.value.info.role === "user" ? previous.value.info : undefined
    const name = payload.agent ?? session.agent ?? user?.agent
    const agent = name ? yield* agents.get(name) : yield* agents.defaultInfo()
    if (!agent) return yield* new Invalid({ message: `Unknown agent: ${name}` })
    const model = session.model
      ? {
          providerID: session.model.providerID,
          modelID: session.model.id,
          ...(session.model.variant && session.model.variant !== "default" ? { variant: session.model.variant } : {}),
        }
      : (user?.model ?? (yield* provider.defaultModel().pipe(Effect.orDie)))
    yield* reconcile(
      events.publish(SessionV1.Event.InputAdmitted, {
        sessionID,
        payload,
        agent: agent.name,
        model,
        time: yield* Clock.currentTimeMillis,
      }),
    )
    const row = yield* find(payload.requestID)
    if (!row) return yield* Effect.die("Input admission was not projected")
    if (row.session_id !== sessionID || !isDeepStrictEqual(row.payload, payload))
      return yield* new Conflict({ message: "requestID already used for a different input" })
    return row.receipt
  })

  const list = Effect.fn("SessionInput.list")(function* (
    sessionID: SessionID,
    query: {
      state?: SessionV1.InputReceipt["state"] | "all"
      limit?: number
      after?: number
    } = {},
  ) {
    const rows = yield* db
      .select()
      .from(V1InputTable)
      .where(
        and(
          eq(V1InputTable.session_id, sessionID),
          query.state === "all" ? undefined : eq(V1InputTable.state, query.state ?? "pending"),
          query.after === undefined ? undefined : gt(V1InputTable.admitted_seq, query.after),
        ),
      )
      .orderBy(asc(V1InputTable.admitted_seq))
      .limit((query.limit ?? 100) + 1)
      .all()
      .pipe(Effect.orDie)
    const items = rows.slice(0, query.limit ?? 100).map((row) => row.receipt)
    return { items, next: rows.length > items.length ? (items.at(-1)?.admittedSeq ?? null) : null }
  })

  const cancel = Effect.fn("SessionInput.cancel")(function* (sessionID: SessionID, requestID: string) {
    const receipt = yield* get(sessionID, requestID)
    if (receipt.state === "cancelled") return receipt
    if (receipt.state === "pending")
      yield* reconcile(
        events.publish(SessionV1.Event.InputCancelled, { sessionID, requestID, time: yield* Clock.currentTimeMillis }),
      )
    const result = yield* get(sessionID, requestID)
    if (result.state === "promoted") return yield* new Conflict({ message: "Input already promoted" })
    return result
  })

  const promote = Effect.fn("SessionInput.promote")(function* (sessionID: SessionID, idle: boolean) {
    // Snapshot the finite batch before publishing; arrivals belong to the next boundary.
    const rows = yield* db
      .select()
      .from(V1InputTable)
      .where(and(eq(V1InputTable.session_id, sessionID), eq(V1InputTable.state, "pending")))
      .orderBy(asc(V1InputTable.admitted_seq))
      .all()
      .pipe(Effect.orDie)
    const selected = idle ? rows : rows.filter((row) => row.payload.delivery === "steer")
    let promoted = false
    for (const row of selected) {
      const info: SessionV1.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: row.receipt.agent,
        model: row.model,
        time: { created: yield* Clock.currentTimeMillis },
      }
      const part: SessionV1.TextPart = {
        id: PartID.ascending(),
        sessionID,
        messageID: info.id,
        type: "text",
        text: row.payload.text,
      }
      yield* reconcile(
        events.publish(SessionV1.Event.InputPromoted, { sessionID, requestID: row.request_id, info, part }),
      )
      const receipt = yield* get(sessionID, row.request_id).pipe(Effect.orDie)
      if (receipt.state !== "promoted" || receipt.messageID !== info.id) continue
      // Existing transcript subscribers consume the legacy message/part events.
      yield* sessions.updateMessage(info)
      yield* sessions.updatePart(part)
      promoted = true
      if (idle) break
    }
    return promoted
  })
  return { admit, get, list, cancel, promote }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/SessionInput") {}
export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Database.node, EventV2Bridge.node, Session.node, Agent.node, Provider.node],
})
export * as SessionInput from "./input"

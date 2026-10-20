import { isDeepStrictEqual } from "node:util"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InputHandlePayload, InputUpdatePayload } from "@opencode-ai/schema/session-v1"
import { V1InputTable, V1InputCommandTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { SessionInputMedia } from "./input-media"
import { Session } from "./session"
import { SessionRunState } from "./run-state"
import { MessageID, PartID, SessionID } from "./schema"

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("InputConflict", { message: Schema.String }) {}
export class UpdateConflict extends Schema.TaggedErrorClass<UpdateConflict>()("InputUpdateConflict", {
  message: Schema.String,
  current: SessionV1.InputReceipt,
}) {}
export class Missing extends Schema.TaggedErrorClass<Missing>()("InputMissing", { message: Schema.String }) {}
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("InputInvalid", { message: Schema.String }) {}

export const InputPayload = SessionV1.InputPayload
export { InputUpdatePayload }

const make = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const media = yield* SessionInputMedia.Service
  const runState = yield* SessionRunState.Service
  const db = database.db
  // The legacy input projector lives in Core; this V1-only extension registers
  // alongside it so durable handling events project on publish and replay.
  yield* events.project(SessionV1.Event.InputHandled, (event) =>
    Effect.gen(function* () {
      const row = yield* db
        .select()
        .from(V1InputTable)
        .where(
          and(eq(V1InputTable.session_id, event.data.sessionID), eq(V1InputTable.request_id, event.data.requestID)),
        )
        .get()
        .pipe(Effect.orDie)
      if (
        !row ||
        row.payload.source?.type !== "editspace-mail" ||
        row.state !== "promoted" ||
        !("timePresented" in row.receipt) ||
        typeof row.receipt.timePresented !== "number" ||
        "timeHandled" in row.receipt
      )
        return yield* Effect.die(new SessionProjector.InputLifecycleConflict())
      yield* db
        .update(V1InputTable)
        .set({
          receipt: event.data.replyID
            ? sql`json_set(${V1InputTable.receipt}, '$.timeHandled', ${event.data.time}, '$.disposition', ${event.data.disposition}, '$.replyID', ${event.data.replyID})`
            : sql`json_set(${V1InputTable.receipt}, '$.timeHandled', ${event.data.time}, '$.disposition', ${event.data.disposition})`,
        })
        .where(eq(V1InputTable.request_id, event.data.requestID))
        .run()
        .pipe(Effect.orDie)
    }),
  )
  const reconcile = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.catchDefect((error) =>
        error instanceof SessionProjector.InputLifecycleConflict ? Effect.void : Effect.die(error),
      ),
    )

  const find = (requestID: string) =>
    db.select().from(V1InputTable).where(eq(V1InputTable.request_id, requestID)).get().pipe(Effect.orDie)

  const receipt = (value: SessionV1.InputReceipt): SessionV1.InputReceipt => {
    const current = { ...value, revision: value.revision ?? 0 }
    if (
      current.state === "promoted" &&
      "timePresented" in current &&
      typeof current.timePresented === "number" &&
      "timeHandled" in current &&
      typeof current.timeHandled === "number" &&
      "disposition" in current &&
      (current.disposition === "acknowledged" || current.disposition === "replied")
    )
      return {
        ...current,
        state: "handled",
        timePresented: current.timePresented,
        timeHandled: current.timeHandled,
        disposition: current.disposition,
      }
    if (current.state !== "promoted" || !("timePresented" in current) || typeof current.timePresented !== "number")
      return current
    return { ...current, state: "presented", timePresented: current.timePresented }
  }

  const get = Effect.fn("SessionInput.get")(function* (sessionID: SessionID, requestID: string) {
    const row = yield* find(requestID)
    if (!row || row.session_id !== sessionID) return yield* new Missing({ message: "Input not found" })
    return receipt(row.receipt)
  })

  const update = Effect.fn("SessionInput.update")(function* (
    sessionID: SessionID,
    requestID: string,
    command: InputUpdatePayload,
  ) {
    const normalized = {
      commandID: command.commandID,
      expectedRevision: command.expectedRevision,
      ...(command.text === undefined ? {} : { text: command.text }),
      ...(command.delivery === undefined ? {} : { delivery: command.delivery }),
    }
    const row = yield* find(requestID)
    if (!row || row.session_id !== sessionID) return yield* new Missing({ message: "Input not found" })
    const previous = yield* db
      .select()
      .from(V1InputCommandTable)
      .where(eq(V1InputCommandTable.command_id, command.commandID))
      .get()
      .pipe(Effect.orDie)
    if (previous) {
      if (
        previous.session_id === sessionID &&
        previous.request_id === requestID &&
        isDeepStrictEqual(previous.command, normalized)
      )
        return receipt(previous.receipt)
      return yield* new UpdateConflict({
        message: "commandID already used for a different update",
        current: receipt(row.receipt),
      })
    }
    if (row.payload.source !== undefined)
      return yield* new UpdateConflict({ message: "Only human input can be updated", current: receipt(row.receipt) })
    if (command.text === undefined && command.delivery === undefined)
      return yield* new Invalid({ message: "Update requires text or delivery" })
    if (row.state !== "pending" || (row.receipt.revision ?? 0) !== command.expectedRevision)
      return yield* new UpdateConflict({
        message: "Input is no longer pending at the expected revision",
        current: receipt(row.receipt),
      })
    if (command.text !== undefined && !command.text.trim() && !row.images?.length)
      return yield* new Invalid({ message: "Input requires text or images" })
    if (row.images?.length && command.text !== undefined && command.text.length > 128_000)
      return yield* new Invalid({ message: "Image input text is too large" })
    yield* events.publish(SessionV1.Event.InputUpdated, { sessionID, requestID, command: normalized }).pipe(
      Effect.catchDefect((error) =>
        error instanceof SessionProjector.InputLifecycleConflict ? Effect.void : Effect.die(error),
      ),
    )
    const committed = yield* db
      .select()
      .from(V1InputCommandTable)
      .where(eq(V1InputCommandTable.command_id, command.commandID))
      .get()
      .pipe(Effect.orDie)
    if (
      committed &&
      committed.session_id === sessionID &&
      committed.request_id === requestID &&
      isDeepStrictEqual(committed.command, normalized)
    )
      return receipt(committed.receipt)
    const current = yield* find(requestID)
    return yield* new UpdateConflict({
      message: "Input update conflicted",
      current: receipt(current?.receipt ?? row.receipt),
    })
  })

  const observeWake = Effect.fn("SessionInput.observeWake")(function* (
    sessionID: SessionID,
    requestID: string,
    outcome: "scheduled" | "coalesced",
    observedAt: number,
  ) {
    yield* events.publish(SessionV1.Event.InputWakeObserved, { sessionID, requestID, outcome, observedAt })
    return yield* get(sessionID, requestID)
  })

  const admitInner = Effect.fn("SessionInput.admitInner")(function* (
    sessionID: SessionID,
    payload: typeof InputPayload.Type,
  ) {
    if (!payload.text.trim() && !payload.images?.length)
      return yield* new Invalid({ message: "Input requires text or images" })
    if (payload.images?.length && payload.text.length > 128_000)
      return yield* new Invalid({ message: "Image input text is too large" })
    const existing = yield* find(payload.requestID)
    if (existing) {
      if (existing.session_id !== sessionID || !isDeepStrictEqual(existing.payload, payload))
        return yield* new Conflict({ message: "requestID already used for a different input" })
      return receipt(existing.receipt)
    }
    const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
    const previous = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user").pipe(Effect.orDie)
    const user = Option.isSome(previous) && previous.value.info.role === "user" ? previous.value.info : undefined
    const name = payload.agent ?? session.agent ?? user?.agent
    const agent = name ? yield* agents.get(name) : yield* agents.defaultInfo()
    if (!agent) return yield* new Invalid({ message: `Unknown agent: ${name}` })
    const selected = session.preferredModel ?? session.model
    const model = selected
      ? {
          providerID: selected.providerID,
          modelID: selected.id,
          ...(selected.variant && selected.variant !== "default" ? { variant: selected.variant } : {}),
        }
      : (user?.model ?? (yield* provider.defaultModel().pipe(Effect.orDie)))
    const images = payload.images?.length
      ? yield* provider.getModel(model.providerID, model.modelID).pipe(
          Effect.mapError(() => new Invalid({ message: "Selected image model is unavailable" })),
          Effect.flatMap((selected) => media.normalize(payload.images ?? [], selected)),
          Effect.mapError((error) => new Invalid({ message: error.message })),
        )
      : undefined
    yield* reconcile(
      events.publish(SessionV1.Event.InputAdmitted, {
        sessionID,
        payload,
        agent: agent.name,
        model,
        ...(images ? { images } : {}),
        time: yield* Clock.currentTimeMillis,
      }),
    ).pipe(
      Effect.catchDefect((error) =>
        error instanceof SessionProjector.InputCapacityExceeded
          ? new Invalid({
              message:
                "Session input storage limit exceeded; start a new session or remove this session's retained data",
            })
          : Effect.die(error),
      ),
    )
    const row = yield* find(payload.requestID)
    if (!row) return yield* Effect.die("Input admission was not projected")
    if (row.session_id !== sessionID || !isDeepStrictEqual(row.payload, payload))
      return yield* new Conflict({ message: "requestID already used for a different input" })
    return receipt(row.receipt)
  })
  const admit = (sessionID: SessionID, payload: typeof InputPayload.Type) =>
    runState.admit(sessionID, admitInner(sessionID, payload))

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
          query.state === "all"
            ? undefined
            : eq(
                V1InputTable.state,
                query.state === "presented" || query.state === "handled" ? "promoted" : (query.state ?? "pending"),
              ),
          query.state === "presented"
            ? sql`json_extract(${V1InputTable.receipt}, '$.timePresented') is not null and json_extract(${V1InputTable.receipt}, '$.timeHandled') is null`
            : undefined,
          query.state === "handled"
            ? sql`json_extract(${V1InputTable.receipt}, '$.timeHandled') is not null`
            : undefined,
          query.state === "promoted"
            ? sql`json_extract(${V1InputTable.receipt}, '$.timePresented') is null`
            : undefined,
          query.after === undefined ? undefined : gt(V1InputTable.admitted_seq, query.after),
        ),
      )
      .orderBy(asc(V1InputTable.admitted_seq))
      .limit((query.limit ?? 100) + 1)
      .all()
      .pipe(Effect.orDie)
    const items = rows.slice(0, query.limit ?? 100).map((row) => receipt(row.receipt))
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
    if (result.state === "promoted" || result.state === "presented" || result.state === "handled")
      return yield* new Conflict({ message: "Input already promoted" })
    return result
  })

  const handle = Effect.fn("SessionInput.handle")(function* (
    sessionID: SessionID,
    requestID: string,
    payload: InputHandlePayload,
  ) {
    const current = yield* get(sessionID, requestID)
    if (current.source?.type !== "editspace-mail")
      return yield* new Conflict({ message: "Only editspace mail can be handled" })
    const matches = (value: SessionV1.InputReceipt) =>
      value.state === "handled" && value.disposition === payload.disposition && value.replyID === payload.replyID
    if (matches(current)) return current
    if (current.state !== "presented") return yield* new Conflict({ message: "Mail must be presented before handling" })
    yield* events
      .publish(SessionV1.Event.InputHandled, {
        sessionID,
        requestID,
        disposition: payload.disposition,
        ...(payload.replyID ? { replyID: payload.replyID } : {}),
        time: yield* Clock.currentTimeMillis,
      })
      .pipe(
        Effect.catchDefect((error) =>
          error instanceof SessionProjector.InputLifecycleConflict ? Effect.void : Effect.die(error),
        ),
      )
    const result = yield* get(sessionID, requestID)
    if (matches(result)) return result
    return yield* new Conflict({ message: "Mail already handled with a different disposition" })
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
    const selected = idle ? rows : rows.filter((row) => row.receipt.delivery === "steer")
    let promoted = false
    let promotedModel: SessionV1.User["model"] | undefined
    for (const row of selected) {
      // Every newly promoted image must reach a turn using its admitted model.
      if (promotedModel && !isDeepStrictEqual(promotedModel, row.model)) break
      if (row.images?.length) {
        const selectedModel = yield* provider.getModel(row.model.providerID, row.model.modelID).pipe(Effect.option)
        if (Option.isNone(selectedModel) || !selectedModel.value.capabilities.input.image) {
          if (idle) break
          continue
        }
      }
      const payload = Schema.decodeUnknownSync(InputPayload)(row.payload)
      const info: SessionV1.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: row.receipt.agent,
        model: row.model,
        ...(payload.source ? { source: payload.source } : {}),
        time: { created: yield* Clock.currentTimeMillis },
      }
      const part: SessionV1.TextPart = {
        id: PartID.ascending(),
        sessionID,
        messageID: info.id,
        type: "text",
          text: row.receipt.text,
      }
      const images = (row.images ?? []).map((image) => ({
        ...image,
        id: PartID.ascending(),
        sessionID,
        messageID: info.id,
      }))
      yield* reconcile(
        events.publish(SessionV1.Event.InputPromoted, {
          sessionID,
          requestID: row.request_id,
          revision: row.receipt.revision ?? 0,
          delivery: row.receipt.delivery,
          info,
          part,
          ...(images.length ? { images } : {}),
        }),
      )
      const receipt = yield* get(sessionID, row.request_id).pipe(Effect.orDie)
      if (receipt.state !== "promoted" || receipt.messageID !== info.id) continue
      // Existing transcript subscribers consume the legacy message/part events.
      yield* sessions.updateMessage(info)
      yield* sessions.updatePart(part)
      for (const image of images) yield* sessions.updatePart(image)
      promoted = true
      promotedModel = row.model
      if (idle) break
    }
    return promoted
  })
  const presented = Effect.fn("SessionInput.presented")(function* (sessionID: SessionID, messageIDs: MessageID[]) {
    if (!messageIDs.length) return
    const rows = yield* db
      .select()
      .from(V1InputTable)
      .where(
        and(
          eq(V1InputTable.session_id, sessionID),
          eq(V1InputTable.state, "promoted"),
          inArray(sql`json_extract(${V1InputTable.receipt}, '$.messageID')`, messageIDs),
          sql`json_extract(${V1InputTable.receipt}, '$.timePresented') is null`,
          sql`json_extract(${V1InputTable.payload}, '$.source.type') = 'editspace-mail'`,
        ),
      )
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) {
      if (row.receipt.state !== "promoted") continue
      yield* reconcile(
        events.publish(SessionV1.Event.InputPresented, {
          sessionID,
          requestID: row.request_id,
          messageID: row.receipt.messageID,
          time: yield* Clock.currentTimeMillis,
        }),
      )
    }
  })
  return { admit, get, list, update, cancel, handle, promote, presented, observeWake }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/SessionInput") {}
export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [
    Database.node,
    EventV2Bridge.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionInputMedia.node,
    SessionRunState.node,
  ],
})
export * as SessionInput from "./input"

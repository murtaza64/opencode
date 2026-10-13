import { expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable, V1InputTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceBootstrap } from "@/project/bootstrap"
import { SessionInput } from "@/session/input"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Session.node, SessionInput.node, SessionProjector.node, EventV2.node, Database.node]),
    [[InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))]],
  ),
)

it.instance("replays presented mail before handling without fabricating a projected status", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ title: "Mail replay" })
    const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
    const source = { type: "editspace-mail", id: "mail-replay", sender: "a", recipient: "b" } as const
    const payload = { requestID: "mail-replay", delivery: "queue", text: "please review", source } as const
    const messageID = SessionV1.MessageID.ascending()
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload,
      agent: "build",
      model,
      time: 10,
    })
    yield* events.publish(SessionV1.Event.InputPromoted, {
      sessionID: session.id,
      requestID: payload.requestID,
      info: {
        id: messageID,
        sessionID: session.id,
        role: "user",
        agent: "build",
        model,
        source,
        time: { created: 20 },
      },
      part: {
        id: SessionV1.PartID.ascending(),
        messageID,
        sessionID: session.id,
        type: "text",
        text: payload.text,
      },
    })
    expect((yield* inputs.get(session.id, payload.requestID)).state).toBe("promoted")
    expect(
      (yield* db.select().from(V1InputTable).where(eq(V1InputTable.request_id, payload.requestID)).get())?.state,
    ).toBe("promoted")

    expect(
      yield* events
        .publish(SessionV1.Event.InputPresented, {
          sessionID: session.id,
          requestID: payload.requestID,
          messageID: SessionV1.MessageID.ascending(),
          time: 21,
        })
        .pipe(Effect.catchDefect(Effect.succeed)),
    ).toBeInstanceOf(SessionProjector.InputLifecycleConflict)

    yield* inputs.presented(session.id, [messageID])
    const presented = yield* inputs.get(session.id, payload.requestID)
    expect(presented).toMatchObject({ state: "presented", messageID })
    expect(
      (yield* db.select().from(V1InputTable).where(eq(V1InputTable.request_id, payload.requestID)).get())?.receipt,
    ).toMatchObject({
      state: "promoted",
      timePresented: presented.state === "presented" ? presented.timePresented : undefined,
    })
    yield* inputs.presented(session.id, [messageID])
    expect(yield* inputs.get(session.id, payload.requestID)).toEqual(presented)
    const handled = yield* inputs.handle(session.id, payload.requestID, { disposition: "acknowledged" })
    expect(handled).toMatchObject({
      state: "handled",
      timePresented: presented.state === "presented" ? presented.timePresented : undefined,
    })

    const stored = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, session.id))
      .orderBy(asc(EventTable.seq))
      .all()
    expect(
      stored.filter((event) => event.type === EventV2.versionedType(SessionV1.Event.InputPresented.type, 1)),
    ).toHaveLength(1)
    expect(
      stored.map((event) => event.type).indexOf(EventV2.versionedType(SessionV1.Event.InputPresented.type, 1)),
    ).toBeLessThan(
      stored.map((event) => event.type).indexOf(EventV2.versionedType(SessionV1.Event.InputHandled.type, 1)),
    )
    yield* events.remove(session.id)
    yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run()
    const serialized = stored.map((event) => ({
      id: event.id,
      aggregateID: event.aggregate_id,
      seq: event.seq,
      type: event.type,
      data: event.data,
    }))
    yield* events.replayAll(serialized)
    expect(yield* db.select().from(V1InputTable).where(eq(V1InputTable.request_id, payload.requestID)).get()).toMatchObject({
      session_id: session.id,
      state: "promoted",
      receipt: {
        timePresented: presented.state === "presented" ? presented.timePresented : undefined,
        timeHandled: handled.state === "handled" ? handled.timeHandled : undefined,
        disposition: "acknowledged",
      },
    })
    yield* events.replayAll(serialized)
    expect(
      (yield* db.select().from(V1InputTable).where(eq(V1InputTable.request_id, payload.requestID)).get())?.receipt,
    ).toMatchObject({
      timePresented: presented.state === "presented" ? presented.timePresented : undefined,
      timeHandled: handled.state === "handled" ? handled.timeHandled : undefined,
      disposition: "acknowledged",
    })
  }),
)

import { expect } from "bun:test"
import { asc, eq, sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
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
import { inputImage } from "../fixture/input-image"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Session.node, SessionInput.node, SessionProjector.node, EventV2.node, Database.node]),
    [[InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))]],
  ),
)

it.instance("wake observations remain append-only across edits command retries and promotion", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ title: "Combined pending input and causal wake" })
    const payload = { requestID: "combined-wake-edit", delivery: "queue", text: "original" } as const
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: 10,
    })
    yield* inputs.observeWake(session.id, payload.requestID, "scheduled", 11)
    const command = { commandID: "combined-edit-command", expectedRevision: 0, text: "edited", delivery: "steer" } as const
    const committed = yield* inputs.update(session.id, payload.requestID, command)
    expect(committed.wakeObservations).toEqual([{ outcome: "scheduled", observedAt: 11 }])
    yield* inputs.observeWake(session.id, payload.requestID, "coalesced", 12)
    expect(yield* inputs.update(session.id, payload.requestID, command)).toEqual(committed)
    expect(yield* inputs.admit(session.id, payload)).toMatchObject({
      text: "edited", delivery: "steer", revision: 1,
      wakeObservations: [{ outcome: "scheduled", observedAt: 11 }, { outcome: "coalesced", observedAt: 12 }],
    })
    expect(yield* inputs.promote(session.id, false)).toBe(true)
    expect(yield* inputs.get(session.id, payload.requestID)).toMatchObject({
      state: "promoted", text: "edited", delivery: "steer", revision: 1,
      wakeObservations: [{ outcome: "scheduled", observedAt: 11 }, { outcome: "coalesced", observedAt: 12 }],
    })
    expect(yield* inputs.update(session.id, payload.requestID, command)).toEqual(committed)
    expect(yield* inputs.promote(session.id, false)).toBe(false)
  }),
)

it.instance("updates only pending human input and retains admission identity across replay and promotion", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ title: "Edit pending input" })
    const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
    const payload = { requestID: "edit-pending", delivery: "queue", text: "first", agent: "build" } as const
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload,
      agent: "build",
      model,
      time: 10,
    })
    yield* db
      .update(V1InputTable)
      .set({ receipt: sql`json_remove(${V1InputTable.receipt}, '$.revision')` })
      .where(eq(V1InputTable.request_id, payload.requestID))
      .run()
    const original = yield* inputs.get(session.id, payload.requestID)
    expect(original.revision).toBe(0)
    const first = { commandID: "edit-1", expectedRevision: 0, text: "second", delivery: "steer" } as const
    const edited = yield* inputs.update(session.id, payload.requestID, first)
    expect(edited).toMatchObject({
      state: "pending",
      revision: 1,
      text: "second",
      delivery: "steer",
      admittedSeq: original.admittedSeq,
      agent: "build",
      requestID: payload.requestID,
    })
    expect(
      (yield* db.select().from(V1InputTable).where(eq(V1InputTable.request_id, payload.requestID)).get())?.payload,
    ).toEqual(payload)
    expect(yield* inputs.admit(session.id, payload)).toEqual(edited)
    expect(
      yield* inputs.update(session.id, payload.requestID, {
        commandID: "edit-2",
        expectedRevision: 1,
        delivery: "queue",
      }),
    ).toMatchObject({ revision: 2, text: "second", delivery: "queue" })
    expect(yield* inputs.update(session.id, payload.requestID, first)).toEqual(edited)
    expect(
      yield* inputs.update(session.id, payload.requestID, {
        commandID: "edit-3",
        expectedRevision: 2,
        delivery: "steer",
      }),
    ).toMatchObject({ revision: 3, delivery: "steer" })
    const conflict = yield* inputs
      .update(session.id, payload.requestID, { commandID: "edit-3", expectedRevision: 2, text: "different" })
      .pipe(Effect.flip)
    expect(conflict).toMatchObject({ _tag: "InputUpdateConflict", current: { revision: 3 } })
    const other = yield* sessions.create({ title: "Another session" })
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: other.id,
      payload: { ...payload, requestID: "edit-other" },
      agent: "build",
      model,
      time: 11,
    })
    expect(yield* inputs.update(other.id, "edit-other", first).pipe(Effect.flip)).toMatchObject({
      _tag: "InputUpdateConflict",
      current: { sessionID: other.id, revision: 0 },
    })
    const stale = yield* inputs
      .update(session.id, payload.requestID, { commandID: "edit-4", expectedRevision: 2, text: "stale" })
      .pipe(Effect.flip)
    expect(stale).toMatchObject({ _tag: "InputUpdateConflict", current: { revision: 3 } })
    const reused = yield* inputs.admit(session.id, { ...payload, text: "second" }).pipe(Effect.flip)
    expect(reused).toMatchObject({ _tag: "InputConflict" })

    const messageID = SessionV1.MessageID.ascending()
    const info = {
      id: messageID,
      sessionID: session.id,
      role: "user" as const,
      agent: "build",
      model,
      time: { created: 20 },
    }
    const part = {
      id: SessionV1.PartID.ascending(),
      sessionID: session.id,
      messageID,
      type: "text" as const,
      text: "second",
    }
    const before = yield* events
      .publish(SessionV1.Event.InputPromoted, {
        sessionID: session.id,
        requestID: payload.requestID,
        revision: 2,
        delivery: "queue",
        info,
        part,
      })
      .pipe(Effect.catchDefect(Effect.succeed))
    expect(before).toBeInstanceOf(SessionProjector.InputLifecycleConflict)
    const wrongDelivery = yield* events
      .publish(SessionV1.Event.InputPromoted, {
        sessionID: session.id,
        requestID: payload.requestID,
        revision: 3,
        delivery: "queue",
        info,
        part,
      })
      .pipe(Effect.catchDefect(Effect.succeed))
    expect(wrongDelivery).toBeInstanceOf(SessionProjector.InputLifecycleConflict)
    expect((yield* inputs.get(session.id, payload.requestID)).state).toBe("pending")
    yield* events.publish(SessionV1.Event.InputPromoted, {
      sessionID: session.id,
      requestID: payload.requestID,
      revision: 3,
      delivery: "steer",
      info,
      part,
    })
    expect(yield* inputs.get(session.id, payload.requestID)).toMatchObject({
      state: "promoted",
      revision: 3,
      text: "second",
    })
    expect(yield* inputs.update(session.id, payload.requestID, first)).toEqual(edited)
    expect(
      yield* inputs
        .update(session.id, payload.requestID, { commandID: "edit-5", expectedRevision: 3, text: "late" })
        .pipe(Effect.flip),
    ).toMatchObject({ _tag: "InputUpdateConflict", current: { state: "promoted", revision: 3 } })
    const stored = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, session.id))
      .orderBy(asc(EventTable.seq))
      .all()
    yield* events.remove(session.id)
    yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run()
    yield* events.replayAll(
      stored.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
    expect(yield* inputs.get(session.id, payload.requestID)).toMatchObject({
      state: "promoted",
      revision: 3,
      text: "second",
    })
    expect(yield* inputs.update(session.id, payload.requestID, first)).toEqual(edited)
  }),
)

it.instance("concurrent edits use one revision CAS and return the winning receipt on conflict", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ title: "Concurrent edits" })
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload: { requestID: "concurrent", delivery: "queue", text: "admitted" },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: 10,
    })
    const results = yield* Effect.all(
      [
        inputs
          .update(session.id, "concurrent", { commandID: "concurrent-a", expectedRevision: 0, text: "alpha" })
          .pipe(Effect.exit),
        inputs
          .update(session.id, "concurrent", { commandID: "concurrent-b", expectedRevision: 0, text: "beta" })
          .pipe(Effect.exit),
      ],
      { concurrency: "unbounded" },
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)
    const current = yield* inputs.get(session.id, "concurrent")
    expect(current).toMatchObject({ state: "pending", revision: 1 })
    expect(["alpha", "beta"]).toContain(current.text)
    const winning =
      current.text === "alpha"
        ? { commandID: "concurrent-a", expectedRevision: 0, text: "alpha" }
        : { commandID: "concurrent-b", expectedRevision: 0, text: "beta" }
    const losing =
      current.text === "alpha"
        ? { commandID: "concurrent-b", expectedRevision: 0, text: "beta" }
        : { commandID: "concurrent-a", expectedRevision: 0, text: "alpha" }
    expect(yield* inputs.update(session.id, "concurrent", winning)).toEqual(current)
    expect(yield* inputs.update(session.id, "concurrent", losing).pipe(Effect.flip)).toMatchObject({
      _tag: "InputUpdateConflict",
      current: { revision: 1, text: current.text },
    })
  }),
)

it.instance("queue-to-steer waits for a subsequent safe promotion boundary", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ title: "Delivery switch" })
    const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload: { requestID: "switch-delivery", delivery: "queue", text: "boundary text" },
      agent: "build",
      model,
      time: 10,
    })
    expect(yield* inputs.promote(session.id, false)).toBe(false)
    expect(yield* inputs.get(session.id, "switch-delivery")).toMatchObject({ state: "pending", delivery: "queue" })
    yield* inputs.update(session.id, "switch-delivery", {
      commandID: "switch-command",
      expectedRevision: 0,
      delivery: "steer",
    })
    expect(yield* inputs.promote(session.id, false)).toBe(true)
    expect(yield* inputs.get(session.id, "switch-delivery")).toMatchObject({
      state: "promoted",
      revision: 1,
      delivery: "steer",
    })
    expect(yield* inputs.promote(session.id, false)).toBe(false)
    expect(yield* inputs.promote(session.id, true)).toBe(false)
    const visible = (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "user")
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({ info: { model }, parts: [{ type: "text", text: "boundary text" }] })
  }),
)

it.instance("steer-to-queue defers promotion until idle and never duplicates the visible message", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ title: "Deferred steering" })
    const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload: { requestID: "deferred", delivery: "steer", text: "unchanged text" },
      agent: "build",
      model,
      time: 10,
    })
    expect(
      yield* inputs.update(session.id, "deferred", {
        commandID: "defer-command",
        expectedRevision: 0,
        delivery: "queue",
      }),
    ).toMatchObject({ state: "pending", revision: 1, text: "unchanged text", delivery: "queue" })
    expect(yield* inputs.promote(session.id, false)).toBe(false)
    expect(yield* inputs.get(session.id, "deferred")).toMatchObject({ state: "pending", delivery: "queue" })
    expect((yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "user"))
      .toHaveLength(0)
    expect(yield* inputs.promote(session.id, true)).toBe(true)
    expect(yield* inputs.promote(session.id, true)).toBe(false)
    expect(yield* inputs.promote(session.id, false)).toBe(false)
    expect(yield* inputs.get(session.id, "deferred")).toMatchObject({
      state: "promoted",
      revision: 1,
      delivery: "queue",
    })
    const visible = (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "user")
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({ info: { agent: "build", model }, parts: [{ type: "text", text: "unchanged text" }] })
  }),
)

it.instance("rejects edits to sourced input without changing its receipt", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ title: "Mail input" })
    const payload = {
      requestID: "mail-update",
      delivery: "queue",
      text: "mail",
      source: { type: "editspace-mail", id: "mail-update", sender: "a", recipient: "b" },
    } as const
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: 10,
    })
    expect(
      yield* inputs
        .update(session.id, payload.requestID, { commandID: "mail-edit", expectedRevision: 0, text: "changed" })
        .pipe(Effect.flip),
    ).toMatchObject({ _tag: "InputUpdateConflict", current: { text: "mail", revision: 0 } })
  }),
)

it.instance("edits image-only text without changing normalized attachments or admitted model", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ title: "Image edit" })
    const image = yield* inputImage()
    const payload = { requestID: "image-edit", delivery: "queue", text: "", images: [image], agent: "build" } as const
    const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("image-test") }
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload,
      agent: "build",
      model,
      images: [image],
      time: 10,
    })
    const updated = yield* inputs.update(session.id, payload.requestID, {
      commandID: "image-command",
      expectedRevision: 0,
      text: "caption",
      delivery: "steer",
    })
    expect(updated).toMatchObject({ text: "caption", images: [image], revision: 1 })
    expect(yield* inputs.admit(session.id, payload)).toEqual(updated)
    const messageID = SessionV1.MessageID.ascending()
    const partID = SessionV1.PartID.ascending()
    yield* events.publish(SessionV1.Event.InputPromoted, {
      sessionID: session.id,
      requestID: payload.requestID,
      revision: 1,
      delivery: "steer",
      info: { id: messageID, sessionID: session.id, role: "user", agent: "build", model, time: { created: 20 } },
      part: { id: partID, sessionID: session.id, messageID, type: "text", text: "caption" },
      images: [{ ...image, id: SessionV1.PartID.ascending(), sessionID: session.id, messageID }],
    })
    expect(yield* inputs.get(session.id, payload.requestID)).toMatchObject({
      state: "promoted",
      images: [image],
      text: "caption",
    })
    expect((yield* db.select().from(V1InputTable).where(eq(V1InputTable.request_id, payload.requestID)).get())?.model)
      .toEqual(model)
  }),
)

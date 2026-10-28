import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { V1InputTable } from "@opencode-ai/core/session/sql"
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

const userModel = { providerID: ProviderV2.ID.make("user-provider"), modelID: ModelV2.ID.make("user-model") }

it.instance("admission takes agent and model from the latest user message when the session has neither", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({ title: "Unset agent and model" })
    yield* sessions.updateMessage({
      id: SessionV1.MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      agent: "plan",
      model: userModel,
      time: { created: 10 },
    })

    const receipt = yield* inputs.admit(session.id, { requestID: "fallback", delivery: "queue", text: "next" })

    expect(receipt.agent).toBe("plan")
    expect((yield* db.select().from(V1InputTable).where(eq(V1InputTable.request_id, "fallback")).get())?.model).toEqual(
      userModel,
    )
  }),
)

it.instance("admission uses the session agent and model over the latest user message", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const db = (yield* Database.Service).db
    const session = yield* sessions.create({
      title: "Session agent and model",
      agent: "build",
      model: { id: ModelV2.ID.make("session-model"), providerID: ProviderV2.ID.make("session-provider") },
    })
    yield* sessions.updateMessage({
      id: SessionV1.MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      agent: "plan",
      model: userModel,
      time: { created: 10 },
    })

    const receipt = yield* inputs.admit(session.id, { requestID: "session-wins", delivery: "queue", text: "next" })

    expect(receipt.agent).toBe("build")
    expect(
      (yield* db.select().from(V1InputTable).where(eq(V1InputTable.request_id, "session-wins")).get())?.model,
    ).toEqual({ providerID: ProviderV2.ID.make("session-provider"), modelID: ModelV2.ID.make("session-model") })
  }),
)

const context = [
  { text: "export const answer = 42", source: "file", key: "src/answer.ts#L1" },
  { text: "Session summary: shipped U1", source: "session", key: "ses_other" },
]

it.instance("selected context is part of the admitted input and its exact-retry identity", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const session = yield* sessions.create({
      title: "Context",
      agent: "build",
      model: { id: ModelV2.ID.make("m"), providerID: ProviderV2.ID.make("p") },
    })
    const payload = { requestID: "with-context", delivery: "queue", text: "explain", context } as const

    const receipt = yield* inputs.admit(session.id, payload)
    expect(receipt).toMatchObject({ state: "pending", text: "explain", context })
    expect(yield* inputs.admit(session.id, payload)).toEqual(receipt)
    expect(yield* inputs.get(session.id, "with-context")).toEqual(receipt)
    const changed = yield* inputs.admit(session.id, { ...payload, context: context.slice(0, 1) }).pipe(Effect.flip)
    expect(changed._tag).toBe("InputConflict")
  }),
)

it.instance("promotion puts selected context on the same user message as synthetic text parts", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const session = yield* sessions.create({
      title: "Context promotion",
      agent: "build",
      model: { id: ModelV2.ID.make("m"), providerID: ProviderV2.ID.make("p") },
    })
    yield* inputs.admit(session.id, { requestID: "promote-context", delivery: "steer", text: "explain", context })
    expect(yield* inputs.promote(session.id, false)).toBe(true)

    const receipt = yield* inputs.get(session.id, "promote-context")
    expect(receipt).toMatchObject({ state: "promoted", context })
    const message = yield* sessions.findMessage(session.id, (item) => item.info.role === "user")
    const parts = message._tag === "Some" ? message.value.parts : []
    expect(message._tag === "Some" && message.value.info.id).toBe(receipt.state === "promoted" && receipt.messageID)
    expect(parts.map((part) => (part.type === "text" ? [part.text, part.synthetic ?? false, part.metadata] : part.type))).toEqual([
      ["explain", false, undefined],
      // Same metadata shape as context on a plain send, so shared chips and lookups read both alike.
      ["export const answer = 42", true, { source: "file", key: "src/answer.ts#L1" }],
      ["Session summary: shipped U1", true, { source: "session", key: "ses_other" }],
    ])
  }),
)

it.instance("a promotion recorded with the earlier contextSource/contextKey metadata still projects", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inputs = yield* SessionInput.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ title: "Legacy context promotion" })
    const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
    const payload = { requestID: "legacy-context", delivery: "steer", text: "explain", context } as const
    yield* events.publish(SessionV1.Event.InputAdmitted, { sessionID: session.id, payload, agent: "build", model, time: 10 })
    const messageID = SessionV1.MessageID.ascending()
    const part = { id: SessionV1.PartID.ascending(), messageID, sessionID: session.id, type: "text", text: "explain" } as const
    yield* events.publish(SessionV1.Event.InputPromoted, {
      sessionID: session.id,
      requestID: payload.requestID,
      info: { id: messageID, sessionID: session.id, role: "user", agent: "build", model, time: { created: 20 } },
      part,
      context: context.map((item) => ({
        id: SessionV1.PartID.ascending(),
        messageID,
        sessionID: session.id,
        type: "text" as const,
        text: item.text,
        synthetic: true,
        metadata: { contextSource: item.source, contextKey: item.key },
      })),
    })
    expect(yield* inputs.get(session.id, payload.requestID)).toMatchObject({ state: "promoted", messageID })
  }),
)

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

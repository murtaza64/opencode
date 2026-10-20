import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { SessionInput } from "@/session/input"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([Session.node, SessionInput.node, SessionProjector.node, EventV2.node, Database.node]),
    ),
    httpApiLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.instance("PATCH validates commands and returns a 409 with the current receipt", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create({ title: "HTTP input edit" })
    yield* events.publish(SessionV1.Event.InputAdmitted, {
      sessionID: session.id,
      payload: { requestID: "http-input-edit", delivery: "queue", text: "before" },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: 10,
    })
    const url = `/session/${session.id}/input/http-input-edit`
    const patch = (body: unknown) =>
      requestInDirectory(url, test.directory, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const updated = yield* patch({ commandID: "http-edit-1", expectedRevision: 0, text: "after" })
    expect(updated.status).toBe(200)
    expect(yield* updated.json).toMatchObject({ state: "pending", revision: 1, text: "after" })
    const stale = yield* patch({ commandID: "http-edit-2", expectedRevision: 0, delivery: "steer" })
    expect(stale.status).toBe(409)
    expect(yield* stale.json).toMatchObject({
      _tag: "InputUpdateConflict",
      current: { requestID: "http-input-edit", state: "pending", revision: 1, text: "after", delivery: "queue" },
    })
    expect((yield* patch({ commandID: "http-edit-1", expectedRevision: 0, text: "after" })).status).toBe(200)
    expect((yield* patch({ commandID: "http-edit-1", expectedRevision: 0, text: "different" })).status).toBe(409)
    expect((yield* patch({ commandID: "missing-change", expectedRevision: 1 })).status).toBe(400)
    expect((yield* patch({ commandID: "invalid-revision", expectedRevision: -1, text: "bad" })).status).toBe(400)
  }),
)

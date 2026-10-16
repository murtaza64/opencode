// `POST /session` and `POST /session/:id/prompt_async` must answer as soon as the
// project identity resolves, even while the Instance bootstrap (plugin dependency
// install, LSP, …) is still running; the model turn behind prompt_async waits for
// the ready Instance instead (murtaza64/dotfiles#179).
import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { disposeAllInstancesEffect, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Tests swap this per run; the layer below is built once per shared runtime.
let bootstrapRun: Effect.Effect<void> = Effect.void
const gatedBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const appLayer = AppNodeBuilder.build(LayerNode.group([Session.node, InstanceStore.node, CrossSpawnSpawner.node]), [
  [InstanceStore.bootstrapNode, gatedBootstrap],
])

// The served routes compile their own InstanceStore with the production bootstrap.
// Each test builds its layer in an isolated memo map with appLayer underneath the
// routes, so the one memoized InstanceStore is the gated one for both the routes
// and the test body. A shared runtime would reuse whichever InstanceStore an
// earlier test file (or `resetDatabase()`) already built with the real bootstrap.
const it = testEffect(Layer.mergeAll(TestLLMServer.layer, appLayer, httpApiLayer.pipe(Layer.provide(appLayer))))

afterEach(() => {
  bootstrapRun = Effect.void
})

// Bootstrap blocks until the test releases it, standing in for a slow npm reify.
// Instances are disposed through this test's own store before its runtime closes.
const gateBootstrap = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => disposeAllInstancesEffect.pipe(Effect.ignore))
  const started = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  bootstrapRun = Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(release)
  })
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
  return { started, release }
})

const post = (directory: string, path: string, body: unknown) =>
  requestInDirectory(path, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

it.live("POST /session answers before a slow instance bootstrap completes", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const store = yield* InstanceStore.Service
    const gate = yield* gateBootstrap

    const response = yield* post(dir, "/session", { title: "boot pending" })
    expect(response.status).toBe(200)
    const session = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session.Info)))
    expect(session.directory).toBe(dir)
    expect(session.title).toBe("boot pending")

    yield* Deferred.await(gate.started)
    expect(yield* store.peek(dir)).toBeUndefined()
    expect(store.size()).toBe(1)

    yield* Deferred.succeed(gate.release, undefined)
    const ctx = yield* store.load({ directory: dir })
    expect(ctx.directory).toBe(dir)
    expect(yield* store.peek(dir)).toBe(ctx)
  }),
)

it.live(
  "prompt_async is admitted before bootstrap and the turn runs once the Instance is ready",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("ready now")
      const dir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const store = yield* InstanceStore.Service
      const gate = yield* gateBootstrap
      const created = yield* post(dir, "/session", { title: "boot pending prompt" })
      expect(created.status).toBe(200)
      const session = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session.Info)))

      const admitted = yield* post(dir, `/session/${session.id}/prompt_async`, {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello before boot" }],
      })
      expect(admitted.status).toBe(204)

      yield* Deferred.await(gate.started)
      expect(yield* store.peek(dir)).toBeUndefined()
      expect(yield* llm.calls).toBe(0)

      yield* Deferred.succeed(gate.release, undefined)
      yield* llm.wait(1)
      const messages = yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* requestInDirectory(`/session/${session.id}/message`, dir)
          const items = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
          )
          const assistant = items.find((message) => message.info.role === "assistant")
          return assistant && assistant.parts.some((part) => part.type === "text" && part.text === "ready now")
            ? items
            : undefined
        }),
        "assistant turn did not complete after bootstrap finished",
        "10 seconds",
      )
      expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant"])
    }),
  { timeout: 30_000 },
)

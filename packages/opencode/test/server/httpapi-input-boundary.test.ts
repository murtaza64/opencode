import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// The direct initial prompt and the HTTP handlers must own the same Session runner.
const it = testEffectShared(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilderV1.build(
      LayerNode.group([Session.node, SessionPrompt.node, SessionRunState.node, InstanceStore.node]),
    ),
  ),
)

for (const synthetic of [false, true]) {
  it.live(
    `HTTP late ${synthetic ? "synthetic" : "ordinary"} prompt drains before FIFO queues and exact retries do not rerun`,
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
        const instances = yield* InstanceStore.Service
        yield* Effect.addFinalizer(() => instances.disposeDirectory(directory))
        yield* Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const run = yield* SessionRunState.Service
          const session = yield* sessions.create({ title: "HTTP final boundary" })
          const url = `/session/${session.id}`
          const post = (suffix: string, body: unknown) =>
            requestInDirectory(`${url}/${suffix}`, directory, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          const receipt = (requestID: string) =>
            requestInDirectory(`${url}/input/${requestID}`, directory).pipe(
              Effect.flatMap((response) => response.json),
              Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.InputReceipt)),
            )
          const messages = requestInDirectory(`${url}/message`, directory).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
          )
          const held = Promise.withResolvers<void>()
          const checked = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("original answer").wait(held.promise).stop())
          yield* llm.text("late answer")
          yield* llm.text("first queued answer")
          yield* llm.text("second queued answer")
          const originalID = MessageID.ascending()
          const original = yield* prompt
            .prompt({
              sessionID: session.id,
              messageID: originalID,
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
              parts: [{ type: "text", text: "original task" }],
            })
            .pipe(
              Effect.provideService(
                SessionPrompt.FinalBoundary,
                Effect.gen(function* () {
                  if (yield* Deferred.isDone(checked)) return
                  yield* Deferred.succeed(checked, undefined)
                  yield* Deferred.await(release)
                }),
              ),
              Effect.forkChild,
            )
          yield* llm.wait(1)
          held.resolve()
          yield* Deferred.await(checked)
          const lateID = MessageID.ascending()
          expect(
            (yield* post("prompt_async", {
              messageID: lateID,
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "late task", synthetic }],
            })).status,
          ).toBe(204)
          yield* pollWithTimeout(
            messages.pipe(Effect.map((items) => (items.some((item) => item.info.id === lateID) ? true : undefined))),
            "HTTP late prompt was not appended",
          )
          const q1 = { requestID: "boundary-q1", delivery: "queue", text: "first queued task" }
          const q2 = { requestID: "boundary-q2", delivery: "queue", text: "second queued task" }
          expect((yield* post("input", q1)).status).toBe(200)
          expect((yield* post("input", q2)).status).toBe(200)
          const pending1 = yield* receipt(q1.requestID)
          const pending2 = yield* receipt(q2.requestID)
          expect(pending1.state).toBe("pending")
          expect(pending2.state).toBe("pending")
          expect(yield* (yield* post("input", q1)).json).toEqual(pending1)
          expect(yield* (yield* post("input", q2)).json).toEqual(pending2)
          expect(yield* llm.calls).toBe(1)
          expect(original.pollUnsafe()).toBeUndefined()

          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(original)
          yield* pollWithTimeout(
            run.assertNotBusy(session.id).pipe(
              Effect.as(true),
              Effect.catchTag("SessionBusyError", () => Effect.succeed(undefined)),
            ),
            "HTTP admissions did not drain to idle",
          )
          const terminal1 = yield* receipt(q1.requestID)
          const terminal2 = yield* receipt(q2.requestID)
          expect(terminal1.state).toBe("promoted")
          expect(terminal2.state).toBe("promoted")
          if (terminal1.state !== "promoted" || terminal2.state !== "promoted")
            throw new Error("expected both queued inputs to be promoted")
          const transcript = yield* messages
          expect(transcript.filter((message) => message.info.role === "assistant")).toMatchObject([
            { info: { parentID: originalID, finish: "stop" } },
            { info: { parentID: lateID, finish: "stop" } },
            { info: { parentID: terminal1.messageID, finish: "stop" } },
            { info: { parentID: terminal2.messageID, finish: "stop" } },
          ])
          const requests = yield* llm.inputs
          expect(requests).toHaveLength(4)
          expect(requests[1]?.messages).toContainEqual({ role: "user", content: "late task" })
          expect(requests[1]?.messages).not.toContainEqual({ role: "user", content: "first queued task" })
          expect(requests[1]?.messages).not.toContainEqual({ role: "user", content: "second queued task" })
          expect(requests[2]?.messages).toContainEqual({ role: "user", content: "first queued task" })
          expect(requests[2]?.messages).not.toContainEqual({ role: "user", content: "second queued task" })
          expect(requests[3]?.messages).toContainEqual({ role: "user", content: "second queued task" })

          expect(yield* (yield* post("input", q1)).json).toEqual(terminal1)
          expect(yield* (yield* post("input", q2)).json).toEqual(terminal2)
          expect(yield* receipt(q1.requestID)).toEqual(terminal1)
          expect(yield* receipt(q2.requestID)).toEqual(terminal2)
          yield* run.assertNotBusy(session.id)
          expect(yield* messages).toEqual(transcript)
          expect(yield* llm.calls).toBe(4)
        }).pipe(provideInstanceEffect(directory))
      }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
    15_000,
  )
}

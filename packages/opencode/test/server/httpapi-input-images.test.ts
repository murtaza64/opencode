import { expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2 } from "@opencode-ai/core/event"
import { MessageID, PartID } from "@/session/schema"
import { HistoryEvent } from "@/server/routes/instance/httpapi/groups/sync"
import { provideTmpdirServer } from "../fixture/fixture"
import { inputImage, imageProviderConfig } from "../fixture/input-image"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

it.live(
  "durably admits image-only repeated images and preserves exact retries through promotion",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const image = yield* inputImage()
          const changed = yield* inputImage(42)
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("initial").wait(held.promise).stop())
          yield* llm.text("images received")
          const session = yield* Session.use.create({ title: "Image input" })
          const url = `/session/${session.id}`
          const post = (path: string, body: unknown) =>
            requestInDirectory(path, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          expect(
            (yield* post(`${url}/prompt_async`, {
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "initial" }],
            })).status,
          ).toBe(204)
          yield* llm.wait(1)
          const payload = { requestID: "images-1", delivery: "queue", text: "", images: [image, image] }
          const admitted = yield* post(`${url}/input`, payload)
          expect(admitted.status).toBe(200)
          const receipt = yield* admitted.json
          expect(receipt).toMatchObject({ state: "pending", images: [image, image] })
          expect(yield* (yield* post(`${url}/input`, payload)).json).toEqual(receipt)
          expect((yield* post(`${url}/input`, { ...payload, images: [changed, image] })).status).toBe(409)
          const before = yield* requestInDirectory(`${url}/message`, dir)
          expect(JSON.stringify(yield* before.json)).not.toContain(image.url)
          held.resolve()
          yield* llm.wait(2)
          const calls = yield* llm.inputs
          expect(JSON.stringify(calls[1]).split(image.url)).toHaveLength(3)
          const final = yield* post(`${url}/input`, payload)
          expect(yield* final.json).toMatchObject({ state: "promoted", images: [image, image] })
          expect(yield* llm.inputs).toHaveLength(2)
        }),
      { config: imageProviderConfig },
    ),
  25_000,
)

it.live(
  "sync replay rejects remote media and substituted promotion images atomically",
  () =>
    provideTmpdirServer(
      ({ dir }) =>
        Effect.gen(function* () {
          const image = yield* inputImage()
          const other = yield* inputImage(42)
          const session = yield* Session.use.create({ title: "Replay media boundary" })
          const url = `/session/${session.id}`
          const post = (path: string, body: unknown) =>
            requestInDirectory(path, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          yield* post(`${url}/message`, {
            noReply: true,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "unfinished admission boundary" }],
          })
          yield* post(`${url}/input`, {
            requestID: "tamper-images",
            delivery: "queue",
            text: "pending image",
            images: [image, other],
          })
          const response = yield* post("/sync/history", {})
          const stored = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HistoryEvent))),
          )
          const history = stored
            .filter((event) => event.aggregate_id === session.id)
            .map((event) => ({
              id: event.id,
              seq: event.seq,
              type: event.type,
              aggregateID: event.aggregate_id,
              data: event.data,
            }))
          const replay = (type: string, data: unknown) =>
            post("/sync/replay", {
              directory: dir,
              events: [
                ...history,
                {
                  id: EventV2.ID.create(),
                  seq: (history.at(-1)?.seq ?? -1) + 1,
                  type,
                  aggregateID: session.id,
                  data,
                },
              ],
            })
          const remote = { ...image, url: "https://example.invalid/never-fetch.png" }
          expect(
            (yield* replay("session.input.admitted.1", {
              sessionID: session.id,
              payload: {
                requestID: "remote-image",
                delivery: "queue",
                text: "",
                images: [remote],
              },
              images: [remote],
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              time: Date.now(),
            })).status,
          ).toBeGreaterThanOrEqual(400)
          expect((yield* requestInDirectory(`${url}/input/remote-image`, dir)).status).toBe(404)
          const info = {
            id: MessageID.ascending(),
            role: "user",
            sessionID: session.id,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            time: { created: Date.now() },
          }
          const promotion = {
            sessionID: session.id,
            requestID: "tamper-images",
            info,
            part: {
              type: "text",
              text: "pending image",
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: info.id,
            },
          }
          const part = { ...other, id: PartID.ascending(), sessionID: session.id, messageID: info.id }
          const second = { ...other, id: PartID.ascending(), sessionID: session.id, messageID: info.id }
          expect(
            (yield* replay("session.input.promoted.1", { ...promotion, images: [part, second] })).status,
          ).toBeGreaterThanOrEqual(400)
          expect(
            (yield* replay("session.input.promoted.1", {
              ...promotion,
              images: [
                { ...part, ...image, id: "prt_z" },
                { ...second, id: "prt_a" },
              ],
            })).status,
          ).toBeGreaterThanOrEqual(400)
          expect(yield* (yield* requestInDirectory(`${url}/input/tamper-images`, dir)).json).toMatchObject({
            state: "pending",
          })
          expect((yield* requestInDirectory(`${url}/message/${info.id}`, dir)).status).toBe(404)
          expect(
            (yield* replay("session.input.promoted.1", { ...promotion, images: [{ ...part, ...image }, second] }))
              .status,
          ).toBe(200)
          expect(yield* (yield* requestInDirectory(`${url}/input/tamper-images`, dir)).json).toMatchObject({
            state: "promoted",
          })
          const visible = yield* (yield* requestInDirectory(`${url}/message/${info.id}`, dir)).json
          expect(JSON.stringify(visible)).toContain(image.url)
          expect(JSON.stringify(visible)).toContain(other.url)
        }),
      { config: imageProviderConfig },
    ),
  25_000,
)

it.live(
  "Aside sees only newly attached images and remains tool-free outside the parent transcript",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const old = yield* inputImage()
          const image = yield* inputImage(42)
          yield* llm.text("parent answer")
          yield* llm.text("isolated visual answer")
          const session = yield* Session.use.create({ title: "Aside images" })
          const url = `/session/${session.id}`
          const post = (path: string, body: unknown) =>
            requestInDirectory(path, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          expect(
            (yield* post(`${url}/message`, {
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "historical image" }, old],
            })).status,
          ).toBe(200)
          const before = yield* (yield* requestInDirectory(`${url}/message`, dir)).json
          const answer = yield* post(`${url}/aside`, { requestID: "aside-image", question: "", images: [image, image] })
          expect(answer.status).toBe(200)
          expect(yield* answer.json).toMatchObject({ text: "isolated visual answer" })
          const calls = yield* llm.inputs
          expect(JSON.stringify(calls[1]).split(image.url)).toHaveLength(3)
          expect(JSON.stringify(calls[1])).not.toContain(old.url)
          expect(calls[1]?.tools).toBeUndefined()
          expect(calls[1]?.tool_choice).toBeUndefined()
          expect(yield* (yield* requestInDirectory(`${url}/message`, dir)).json).toEqual(before)
        }),
      { config: imageProviderConfig },
    ),
  25_000,
)

it.live(
  "rejects unsupported models and nonimmutable or invalid image media before admission",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const image = yield* inputImage()
          const session = yield* Session.use.create({
            title: "Media validation",
            agent: "build",
            model: { id: ModelV2.ID.make("text-only"), providerID: ProviderV2.ID.make("test") },
          })
          const url = `/session/${session.id}`
          const post = (path: string, body: unknown) =>
            requestInDirectory(path, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          const payload = { requestID: "unsupported", delivery: "queue", text: "", images: [image] }
          expect((yield* post(`${url}/input`, payload)).status).toBe(400)
          expect((yield* requestInDirectory(`${url}/input/unsupported`, dir)).status).toBe(404)
          expect(
            (yield* post(`${url}/aside`, {
              requestID: "unsupported",
              question: "",
              images: [image],
              model: { providerID: "test", modelID: "text-only" },
            })).status,
          ).toBe(400)
          const supported = yield* Session.use.create({
            title: "Supported model validation",
            agent: "build",
            model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") },
          })
          const input = `/session/${supported.id}/input`
          expect(
            (yield* post(input, { ...payload, images: [{ ...image, url: "file:///never-read-user-image.png" }] }))
              .status,
          ).toBe(400)
          expect(
            (yield* post(input, { ...payload, images: [{ ...image, url: "https://example.invalid/never-fetch.png" }] }))
              .status,
          ).toBe(400)
          expect((yield* post(input, { ...payload, images: [{ ...image, mime: "image/jpeg" }] })).status).toBe(400)
          expect(
            (yield* post(input, { ...payload, images: [{ ...image, url: "data:image/png;base64,bm90LWFuLWltYWdl" }] }))
              .status,
          ).toBe(400)
          expect((yield* post(input, { ...payload, images: Array(9).fill(image) })).status).toBe(400)
          expect((yield* post(input, { ...payload, images: [] })).status).toBe(400)
          expect(
            (yield* post(input, { requestID: "oversized-body", delivery: "queue", text: "x".repeat(17 * 1024 * 1024) }))
              .status,
          ).toBeGreaterThanOrEqual(400)
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: imageProviderConfig },
    ),
  25_000,
)

it.live(
  "bounds pending image admissions and cancellation preserves other inputs' media",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const image = yield* inputImage()
          const session = yield* Session.use.create({ title: "Media quota" })
          const url = `/session/${session.id}`
          const post = (path: string, body: unknown) =>
            requestInDirectory(path, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          yield* post(`${url}/message`, {
            noReply: true,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "unfinished" }],
          })
          const statuses = yield* Effect.forEach(
            Array.from({ length: 64 }, (_, index) => `quota-${index}`),
            (requestID) =>
              post(`${url}/input`, { requestID, delivery: "queue", text: "", images: [image] }).pipe(
                Effect.map((response) => response.status),
              ),
          )
          expect(statuses).toEqual(Array(64).fill(200))
          expect(
            (yield* post(`${url}/input`, { requestID: "quota-overflow", delivery: "queue", text: "", images: [image] }))
              .status,
          ).toBe(400)
          expect((yield* requestInDirectory(`${url}/input/quota-0`, dir, { method: "DELETE" })).status).toBe(200)
          expect(yield* (yield* requestInDirectory(`${url}/input/quota-1`, dir)).json).toMatchObject({
            state: "pending",
            images: [image],
          })
          expect(
            (yield* post(`${url}/input`, { requestID: "quota-overflow", delivery: "queue", text: "", images: [image] }))
              .status,
          ).toBe(200)
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: imageProviderConfig },
    ),
  30_000,
)

it.live(
  "splits steer promotion at model changes so admitted images reach the vision model",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const image = yield* inputImage()
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("original").wait(held.promise).stop())
          yield* llm.text("vision answer")
          yield* llm.text("text answer")
          const session = yield* Session.use.create({ title: "Mixed model steering" })
          const url = `/session/${session.id}`
          const post = (suffix: string, body: unknown) =>
            requestInDirectory(`${url}/${suffix}`, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          yield* post("prompt_async", {
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "initial" }],
          })
          yield* llm.wait(1)
          expect(
            (yield* post("input", { requestID: "vision-steer", delivery: "steer", text: "inspect", images: [image] }))
              .status,
          ).toBe(200)
          expect(
            (yield* post("message", {
              noReply: true,
              agent: "build",
              model: { providerID: "test", modelID: "text-only" },
              parts: [{ type: "text", text: "changed model selection" }],
            })).status,
          ).toBe(200)
          expect(
            (yield* post("input", { requestID: "text-steer", delivery: "steer", text: "later text task" })).status,
          ).toBe(200)
          held.resolve()
          yield* llm.wait(3)
          const calls = yield* llm.inputs
          expect(calls[1]?.model).toBe("test-model")
          expect(JSON.stringify(calls[1])).toContain(image.url)
          expect(JSON.stringify(calls[1])).not.toContain("later text task")
          expect(calls[2]?.model).toBe("text-only")
          expect(JSON.stringify(calls[2])).toContain("later text task")
        }),
      { config: imageProviderConfig },
    ),
  25_000,
)

it.live(
  "cancels image Aside independently without removing another question's media",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const image = yield* inputImage()
          yield* llm.hang
          yield* llm.text("second question answer")
          const session = yield* Session.use.create({ title: "Aside image cancellation" })
          const url = `/session/${session.id}`
          const post = (id: string) =>
            requestInDirectory(`${url}/aside`, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                requestID: id,
                question: "Inspect this image",
                images: [image],
                model: { providerID: "test", modelID: "test-model" },
              }),
            })
          const asking = yield* post("cancel-image").pipe(Effect.forkChild)
          yield* llm.wait(1)
          expect((yield* requestInDirectory(`${url}/aside/cancel-image`, dir, { method: "DELETE" })).status).toBe(200)
          expect((yield* Fiber.join(asking)).status).toBe(400)
          expect((yield* post("second-image")).status).toBe(200)
          expect(JSON.stringify((yield* llm.inputs)[1])).toContain(image.url)
          expect(yield* (yield* requestInDirectory(`${url}/message`, dir)).json).toEqual([])
        }),
      { config: imageProviderConfig },
    ),
  25_000,
)

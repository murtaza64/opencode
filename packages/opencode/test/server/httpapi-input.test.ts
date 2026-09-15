import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { HttpClient } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { TestInstance, provideTmpdirServer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

const readReceipt = (path: string, dir: string) =>
  requestInDirectory(path, dir).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.InputReceipt)),
  )

it.live(
  "permission denial leaves queued and steering inputs pending",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.tool("bash", { command: "printf should-not-run", description: "Request permission" })
          const session = yield* Session.use.create({
            title: "Denied boundary",
            permission: [{ permission: "bash", pattern: "*", action: "ask" }],
          })
          const url = `/session/${session.id}`
          const post = (path: string, body: unknown) =>
            requestInDirectory(path, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          yield* post(`${url}/prompt_async`, {
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "task requiring permission" }],
          })
          const permission = yield* pollWithTimeout(
            Effect.gen(function* () {
              const response = yield* requestInDirectory("/permission", dir)
              const pending = yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PermissionV1.Request))),
              )
              return pending.find((item) => item.sessionID === session.id)
            }),
            "tool did not request permission",
            "10 seconds",
          )
          yield* post(`${url}/input`, { requestID: "denied-queue", delivery: "queue", text: "queued after denial" })
          yield* post(`${url}/input`, { requestID: "denied-steer", delivery: "steer", text: "steered after denial" })
          expect((yield* post(`/permission/${permission.id}/reply`, { reply: "reject" })).status).toBe(200)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const response = yield* requestInDirectory(`${url}/message`, dir)
              const messages = yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
              )
              return messages.some((message) =>
                message.parts.some((part) => part.type === "tool" && part.state.status === "error"),
              )
                ? true
                : undefined
            }),
            "denied tool did not settle",
            "10 seconds",
          )
          expect((yield* readReceipt(`${url}/input/denied-queue`, dir)).state).toBe("pending")
          expect((yield* readReceipt(`${url}/input/denied-steer`, dir)).state).toBe("pending")
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  20_000,
)

it.live(
  "cancel and promotion race leaves either a cancelled receipt or one complete visible message",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("original settled").wait(held.promise).stop())
          yield* llm.text("race input settled")
          const session = yield* Session.use.create({ title: "Cancel race" })
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
            parts: [{ type: "text", text: "original before cancellation race" }],
          })
          yield* llm.wait(1)
          yield* post("input", { requestID: "cancel-race", delivery: "queue", text: "atomic race text" })
          const [cancelled] = yield* Effect.all(
            [
              requestInDirectory(`${url}/input/cancel-race`, dir, { method: "DELETE" }),
              Effect.sync(() => held.resolve()),
            ],
            { concurrency: "unbounded" },
          )
          expect([200, 409]).toContain(cancelled.status)
          const receipt = yield* readReceipt(`${url}/input/cancel-race`, dir)
          const response = yield* requestInDirectory(`${url}/message`, dir)
          const messages = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
          )
          const visible = messages.filter((message) =>
            message.parts.some((part) => part.type === "text" && part.text === "atomic race text"),
          )
          expect(receipt.state).toBe(cancelled.status === 200 ? "cancelled" : "promoted")
          expect(visible).toHaveLength(cancelled.status === 200 ? 0 : 1)
          if (receipt.state === "promoted") expect(visible[0]?.info.id).toBe(receipt.messageID)
        }),
      { config: testProviderConfig },
    ),
  20_000,
)

it.instance("admits an invisible durable input and reconciles retries and cancellation", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const session = yield* Session.use.create({ title: "Input test" })
    // Unfinished history is deliberately not eligible for advisory crash recovery.
    yield* Session.use.updateMessage({
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const url = `/session/${session.id}/input`
    const payload = { requestID: "request-1", delivery: "queue", text: "Do the next task" }
    const post = (body: unknown) =>
      requestInDirectory(url, instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const admitted = yield* post(payload)
    expect(admitted.status).toBe(200)
    const receipt = yield* admitted.json
    expect(receipt).toMatchObject({ ...payload, sessionID: session.id, agent: "build", state: "pending" })
    const retry = yield* post(payload)
    expect(yield* retry.json).toEqual(receipt)
    expect((yield* post({ ...payload, delivery: "steer" })).status).toBe(409)
    expect((yield* post({ ...payload, tools: {} })).status).toBe(400)
    const messages = yield* requestInDirectory(`/session/${session.id}/message`, instance.directory)
    expect(
      yield* messages.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts)))),
    ).toHaveLength(1)
    const listed = yield* requestInDirectory(url, instance.directory)
    expect(yield* listed.json).toEqual({ items: [receipt], next: null })
    const cancelled = yield* requestInDirectory(`${url}/request-1`, instance.directory, { method: "DELETE" })
    expect(cancelled.status).toBe(200)
    const terminal = yield* cancelled.json
    expect(terminal).toMatchObject({ state: "cancelled" })
    const again = yield* requestInDirectory(`${url}/request-1`, instance.directory, { method: "DELETE" })
    expect(yield* again.json).toEqual(terminal)
    expect(yield* (yield* post(payload)).json).toEqual(terminal)
    expect((yield* post({ ...payload, agent: "build" })).status).toBe(409)
    expect((yield* post({ ...payload, requestID: "blank", text: " \n\t" })).status).toBe(400)
    expect((yield* requestInDirectory(`${url}/missing`, instance.directory)).status).toBe(404)
    const concurrent = yield* Effect.all(
      Array.from({ length: 8 }, () =>
        post({ ...payload, requestID: "race" }).pipe(Effect.flatMap((response) => response.json)),
      ),
      { concurrency: "unbounded" },
    )
    expect(concurrent).toEqual(Array(8).fill(concurrent[0]))
    const conflicts = yield* Effect.all(
      [
        post({ ...payload, requestID: "conflict", delivery: "queue" }),
        post({ ...payload, requestID: "conflict", delivery: "steer" }),
      ],
      { concurrency: "unbounded" },
    )
    expect(conflicts.map((response) => response.status).sort()).toEqual([200, 409])
    const client = yield* HttpClient.HttpClient
    const page = yield* client.get(`${url}?state=all&limit=1&directory=${encodeURIComponent(instance.directory)}`)
    expect(yield* page.json).toMatchObject({ items: [terminal] })
    const entry = yield* readReceipt(`${url}/race`, instance.directory)
    const next = yield* client.get(
      `${url}?state=all&after=${entry.admittedSeq}&directory=${encodeURIComponent(instance.directory)}`,
    )
    expect(yield* next.json).toMatchObject({ items: [{ requestID: "conflict" }], next: null })
    expect((yield* client.get(`${url}?workspace=unsupported`)).status).toBe(400)
    expect((yield* client.get(`${url}/race?workspace=unsupported`)).status).toBe(400)
    expect((yield* client.del(`${url}/race?workspace=unsupported`)).status).toBe(400)
    expect((yield* client.post(`${url}?workspace=unsupported`)).status).toBe(400)
    const routed = yield* client.get(`${url}/race?directory=${encodeURIComponent("/nonexistent-input-directory")}`)
    expect(yield* routed.json).toEqual(entry)
    const caps = yield* requestInDirectory("/experimental/capabilities", instance.directory)
    expect(yield* caps.json).toMatchObject({
      sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true },
    })
  }),
)

it.live(
  "abort leaves pending inputs inspectable and exact retries do not resume interrupted work",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.hang
          const session = yield* Session.use.create({ title: "Abort boundary" })
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
            parts: [{ type: "text", text: "interrupted task" }],
          })
          yield* llm.wait(1)
          const payload = { requestID: "abort-pending", delivery: "steer", text: "do not run after abort" }
          expect((yield* post("input", payload)).status).toBe(200)
          expect((yield* post("abort", {})).status).toBe(200)
          expect((yield* readReceipt(`${url}/input/abort-pending`, dir)).state).toBe("pending")
          expect((yield* post("input", payload)).status).toBe(200)
          const messages = yield* requestInDirectory(`${url}/message`, dir)
          expect(JSON.stringify(yield* messages.json)).not.toContain("do not run after abort")
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  20_000,
)

it.live(
  "provider failure does not promote pending queue or steer",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("filtered").wait(held.promise).contentFilter())
          const session = yield* Session.use.create({ title: "Failure boundary" })
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
            parts: [{ type: "text", text: "filtered task" }],
          })
          yield* llm.wait(1)
          yield* post("input", { requestID: "error-queue", delivery: "queue", text: "queued after failure" })
          yield* post("input", { requestID: "error-steer", delivery: "steer", text: "steered after failure" })
          held.resolve()
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const response = yield* requestInDirectory(`${url}/message`, dir)
              const messages = yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
              )
              return messages.some((m) => m.info.role === "assistant" && m.info.error?.name === "ContentFilterError")
                ? true
                : undefined
            }),
            "provider failure was not recorded",
            "10 seconds",
          )
          expect((yield* readReceipt(`${url}/input/error-queue`, dir)).state).toBe("pending")
          expect((yield* readReceipt(`${url}/input/error-steer`, dir)).state).toBe("pending")
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  20_000,
)

it.live(
  "steer waits for held tool approval and precedes queued work at the next provider turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.tool("bash", { command: "printf tool-settled", description: "Report tool settlement" })
          yield* llm.push(reply().text("steered done").wait(held.promise).stop())
          yield* llm.text("queued done")
          const session = yield* Session.use.create({
            title: "Steer boundary",
            agent: "build",
            permission: [{ permission: "bash", pattern: "*", action: "ask" }],
          })
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
              parts: [{ type: "text", text: "original held tool task" }],
            })).status,
          ).toBe(204)
          const permission = yield* pollWithTimeout(
            Effect.gen(function* () {
              const response = yield* requestInDirectory("/permission", dir)
              const pending = yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PermissionV1.Request))),
              )
              return pending.find((item) => item.sessionID === session.id)
            }),
            "tool did not request permission",
            "15 seconds",
          )
          expect(
            (yield* post(`${url}/input`, { requestID: "held-queue", delivery: "queue", text: "queued next task" }))
              .status,
          ).toBe(200)
          expect(
            (yield* post(`${url}/input`, { requestID: "held-steer", delivery: "steer", text: "steer current task" }))
              .status,
          ).toBe(200)
          const pending = yield* requestInDirectory(`${url}/input`, dir)
          expect(yield* pending.json).toMatchObject({ items: [{ state: "pending" }, { state: "pending" }] })
          expect(yield* llm.inputs).toHaveLength(1)
          expect((yield* post(`/permission/${permission.id}/reply`, { reply: "once" })).status).toBe(200)
          yield* llm.wait(2)
          const continuing = (yield* llm.inputs)[1]
          expect(JSON.stringify(continuing)).toContain("steer current task")
          expect(JSON.stringify(continuing)).toContain("tool-settled")
          expect(JSON.stringify(continuing)).not.toContain("queued next task")
          expect(JSON.stringify(continuing)).not.toContain("CRITICAL - MAXIMUM STEPS REACHED")
          held.resolve()
          yield* llm.wait(3)
          expect(JSON.stringify((yield* llm.inputs)[2])).toContain("queued next task")
        }),
      { config: (url) => ({ ...testProviderConfig(url), agent: { build: { steps: 2 } } }) },
    ),
  30_000,
)

it.live(
  "queue waits for multi-turn completion before promoting the next FIFO input",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("original done").wait(held.promise).text("!").stop())
          yield* llm.tool("bash", { command: "printf queued-tool", description: "Complete first queued tool" })
          yield* llm.text("first queued done")
          yield* llm.text("second queued done")
          const session = yield* Session.use.create({
            title: "Queue test",
            permission: [{ permission: "bash", pattern: "*", action: "allow" }],
          })
          const url = `/session/${session.id}`
          const post = (suffix: string, body: unknown) =>
            requestInDirectory(`${url}/${suffix}`, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          const initial = yield* post("prompt_async", {
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "original task" }],
          })
          expect(initial.status).toBe(204)
          yield* llm.wait(1)
          expect((yield* post("input", { requestID: "fifo-1", delivery: "queue", text: "first queued" })).status).toBe(
            200,
          )
          expect((yield* post("input", { requestID: "fifo-2", delivery: "queue", text: "second queued" })).status).toBe(
            200,
          )
          expect(yield* llm.inputs).toHaveLength(1)
          const before = yield* requestInDirectory(`${url}/message`, dir)
          expect(JSON.stringify(yield* before.json)).not.toContain("first queued")
          held.resolve()
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const response = yield* requestInDirectory(`${url}/input/fifo-2`, dir)
              const receipt = yield* response.json
              return typeof receipt === "object" &&
                receipt !== null &&
                "state" in receipt &&
                receipt.state === "promoted"
                ? receipt
                : undefined
            }),
            "second queued input was not promoted",
            "15 seconds",
          )
          yield* llm.wait(4)
          const calls = yield* llm.inputs
          expect(JSON.stringify(calls[1])).toContain("first queued")
          expect(JSON.stringify(calls[1])).not.toContain("second queued")
          expect(JSON.stringify(calls[2])).not.toContain("second queued")
          expect(JSON.stringify(calls[3])).toContain("second queued")
          expect((yield* requestInDirectory(`${url}/input/fifo-1`, dir, { method: "DELETE" })).status).toBe(409)
        }),
      { config: testProviderConfig },
    ),
  25_000,
)

it.live(
  "input after structured completion preserves the selected agent model variant and permissions",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.tool("StructuredOutput", { ok: true })
          yield* llm.text("after structured result")
          const session = yield* Session.use.create({
            title: "Structured boundary",
            permission: [{ permission: "bash", pattern: "*", action: "deny" }],
          })
          const url = `/session/${session.id}`
          const post = (suffix: string, body: unknown) =>
            requestInDirectory(`${url}/${suffix}`, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          const response = yield* post("message", {
            agent: "plan",
            model: { providerID: "test", modelID: "test-model" },
            variant: "focused",
            format: {
              type: "json_schema",
              schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
            },
            parts: [{ type: "text", text: "return structured output" }],
          })
          expect(response.status).toBe(200)
          expect(yield* response.json).toMatchObject({ info: { structured: { ok: true } } })
          const admission = yield* post("input", {
            requestID: "after-structured",
            delivery: "queue",
            text: "continue after structured result",
          })
          expect(admission.status).toBe(200)
          expect(yield* admission.json).toMatchObject({ agent: "plan" })
          yield* llm.wait(2)
          const receipt = yield* readReceipt(`${url}/input/after-structured`, dir)
          expect(receipt.state).toBe("promoted")
          if (receipt.state !== "promoted") throw new Error("Expected promoted structured continuation")
          const message = yield* requestInDirectory(`${url}/message/${receipt.messageID}`, dir)
          expect(yield* message.json).toMatchObject({
            info: {
              agent: "plan",
              model: { providerID: "test", modelID: "test-model", variant: "focused" },
            },
          })
          const current = yield* requestInDirectory(url, dir)
          expect(yield* current.json).toMatchObject({
            permission: [{ permission: "bash", pattern: "*", action: "deny" }],
          })
        }),
      { config: testProviderConfig },
    ),
  25_000,
)

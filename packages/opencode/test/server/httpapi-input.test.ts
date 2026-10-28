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
    const receipt = yield* admitted.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.InputReceipt)))
    expect(receipt).toMatchObject({ ...payload, sessionID: session.id, agent: "build", state: "pending" })
    expect(receipt.wakeObservations).toEqual([{ outcome: "scheduled", observedAt: expect.any(Number) }])
    const beforeGet = yield* readReceipt(`${url}/request-1`, instance.directory)
    expect(beforeGet.wakeObservations).toEqual(receipt.wakeObservations)
    const retry = yield* post(payload)
    const retried = yield* retry.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.InputReceipt)))
    expect(retried.wakeObservations).toHaveLength(2)
    expect(retried.wakeObservations?.[0]).toEqual(receipt.wakeObservations?.[0])
    expect(retried.wakeObservations?.[1]).toMatchObject({ outcome: "scheduled", observedAt: expect.any(Number) })
    expect((yield* post({ ...payload, delivery: "steer" })).status).toBe(409)
    expect((yield* post({ ...payload, tools: {} })).status).toBe(400)
    const messages = yield* requestInDirectory(`/session/${session.id}/message`, instance.directory)
    expect(
      yield* messages.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts)))),
    ).toHaveLength(1)
    const listed = yield* requestInDirectory(url, instance.directory)
    expect(yield* listed.json).toEqual({ items: [retried], next: null })
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
        post({ ...payload, requestID: "race" }).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.InputReceipt)),
        ),
      ),
      { concurrency: "unbounded" },
    )
    expect(concurrent.map((item) => item.wakeObservations?.length).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
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
      sessionAside: { version: 1, cancel: true },
      sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true, interrupt: true, context: true, nudge: true },
      session: { turnTime: true },
      noReplyRecordOnly: true,
    })
  }),
)

it.instance(
  "keeps mail source on pending input and rejects source changes on exact retry",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const session = yield* Session.use.create({
        title: "Mail input",
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") },
      })
      // An unfinished legacy turn prevents an advisory wake from promoting the queued mail.
      yield* Session.use.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      })
      const url = `/session/${session.id}/input`
      const source = { type: "editspace-mail", id: "mail-1", sender: "worker-a", recipient: "worker-b" }
      const payload = { requestID: "mail-1", delivery: "queue", text: "Please inspect this task", source }
      const post = (body: unknown) =>
        requestInDirectory(url, instance.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const admitted = yield* post(payload)
      expect(admitted.status).toBe(200)
      const receipt = yield* admitted.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.InputReceipt)))
      expect(receipt).toMatchObject({ source, state: "pending" })
      expect(receipt.wakeObservations).toHaveLength(1)
      expect(
        (yield* (yield* post(payload)).json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.InputReceipt))))
          .wakeObservations,
      ).toHaveLength(2)
      expect((yield* post({ ...payload, source: { ...source, sender: "worker-c" } })).status).toBe(409)
      expect((yield* post({ ...payload, source: undefined })).status).toBe(409)
      expect((yield* post({ ...payload, source: { ...source, type: "unknown" } })).status).toBe(400)
      expect((yield* post({ ...payload, source: { ...source, recipient: 123 } })).status).toBe(400)
      const current = yield* readReceipt(`${url}/mail-1`, instance.directory)
      expect(current.wakeObservations).toHaveLength(2)
      expect(yield* (yield* requestInDirectory(url, instance.directory)).json).toEqual({ items: [current], next: null })
      const handle = (requestID: string) =>
        requestInDirectory(`${url}/${requestID}/handle`, instance.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disposition: "acknowledged" }),
        })
      expect((yield* handle("mail-1")).status).toBe(409)
      expect((yield* handle("missing")).status).toBe(404)
    }),
  20_000,
)

it.live(
  "mail receipt records presentation only after the model responds, and preserves it on retry",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const first = Promise.withResolvers<void>()
          const second = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              first.resolve()
              second.resolve()
            }),
          )
          yield* llm.push(reply().text("original").wait(first.promise).stop())
          yield* llm.push(reply().wait(second.promise).text("mail received").stop())
          const session = yield* Session.use.create({ title: "Mail receipt", agent: "build" })
          const url = `/session/${session.id}/input`
          const payload = {
            requestID: "mail-receipt",
            delivery: "queue",
            text: "mail message",
            source: { type: "editspace-mail", id: "mail-2", sender: "a", recipient: "b" },
          }
          const post = (path: string, body: unknown) =>
            requestInDirectory(path, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          yield* post(`/session/${session.id}/prompt_async`, {
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "original task" }],
          })
          yield* llm.wait(1)
          expect(yield* (yield* post(url, payload)).json).toMatchObject({
            state: "pending",
            wakeObservations: [{ outcome: "coalesced", observedAt: expect.any(Number) }],
          })
          first.resolve()
          yield* llm.wait(2)
          const promoted = yield* pollWithTimeout(
            readReceipt(`${url}/mail-receipt`, dir).pipe(
              Effect.map((receipt) => (receipt.state === "promoted" ? receipt : undefined)),
            ),
            "mail input was not promoted",
            "10 seconds",
          )
          expect("timePresented" in promoted).toBe(false)
          expect(promoted.wakeObservations).toHaveLength(1)
          expect(yield* (yield* requestInDirectory(`${url}?state=promoted`, dir)).json).toMatchObject({
            items: [promoted],
          })
          expect(yield* (yield* requestInDirectory(`${url}?state=presented`, dir)).json).toEqual({
            items: [],
            next: null,
          })
          second.resolve()
          const presented = yield* pollWithTimeout(
            readReceipt(`${url}/mail-receipt`, dir).pipe(
              Effect.map((receipt) => (receipt.state === "presented" ? receipt : undefined)),
            ),
            "mail input was not presented",
            "10 seconds",
          )
          expect(presented.messageID).toBe(promoted.messageID)
          expect(presented.wakeObservations).toEqual(promoted.wakeObservations)
          expect(presented.timePresented).toBeGreaterThanOrEqual(promoted.timePromoted)
          expect(yield* (yield* post(url, payload)).json).toEqual(presented)
          expect(yield* (yield* requestInDirectory(`${url}?state=all`, dir)).json).toMatchObject({ items: [presented] })
          expect(yield* (yield* requestInDirectory(`${url}?state=presented`, dir)).json).toMatchObject({
            items: [presented],
          })
          expect(yield* (yield* requestInDirectory(`${url}?state=promoted`, dir)).json).toEqual({
            items: [],
            next: null,
          })
          expect((yield* requestInDirectory(`${url}/mail-receipt`, dir, { method: "DELETE" })).status).toBe(409)
          const handledResponses = yield* Effect.all(
            Array.from({ length: 2 }, () =>
              post(`${url}/mail-receipt/handle`, {
                disposition: "replied",
                replyID: "reply-1",
              }),
            ),
            { concurrency: "unbounded" },
          )
          expect(handledResponses.map((response) => response.status)).toEqual([200, 200])
          const handled = yield* readReceipt(`${url}/mail-receipt`, dir)
          expect(handled.state).toBe("handled")
          if (handled.state !== "handled") throw new Error("Expected handled mail")
          expect(handled).toMatchObject({
            state: "handled",
            timePresented: presented.timePresented,
            disposition: "replied",
            replyID: "reply-1",
          })
          expect(handled.timeHandled).toBeGreaterThanOrEqual(presented.timePresented)
          expect(
            yield* (yield* post(`${url}/mail-receipt/handle`, {
              disposition: "replied",
              replyID: "reply-1",
            })).json,
          ).toEqual(handled)
          expect(
            (yield* post(`${url}/mail-receipt/handle`, {
              disposition: "replied",
              replyID: "reply-2",
            })).status,
          ).toBe(409)
          expect((yield* post(`${url}/mail-receipt/handle`, { disposition: "acknowledged" })).status).toBe(409)
          expect((yield* post(`${url}/mail-receipt/handle`, { disposition: "replied", extra: true })).status).toBe(400)
          expect(yield* (yield* requestInDirectory(`${url}?state=handled`, dir)).json).toEqual({
            items: [handled],
            next: null,
          })
          expect(yield* (yield* requestInDirectory(`${url}?state=presented`, dir)).json).toEqual({
            items: [],
            next: null,
          })
          expect(yield* (yield* post(url, payload)).json).toEqual(handled)
          const concurrent = yield* Effect.all(
            ["acknowledged", "replied"].map((disposition) => post(`${url}/mail-receipt/handle`, { disposition })),
            { concurrency: "unbounded" },
          )
          expect(concurrent.map((response) => response.status)).toEqual([409, 409])
          const messages = yield* (yield* requestInDirectory(`/session/${session.id}/message`, dir)).json
          expect(JSON.stringify(messages)).not.toContain("reply-1")
        }),
      { config: testProviderConfig },
    ),
  30_000,
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
          // abort takes no body; a JSON body here leaves the test fiber interrupted at teardown.
          expect((yield* requestInDirectory(`${url}/abort`, dir, { method: "POST" })).status).toBe(200)
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
            (yield* post(`${url}/input`, {
              requestID: "held-queue",
              delivery: "queue",
              text: "queued next task",
              source: { type: "editspace-mail", id: "queue-mail", sender: "a", recipient: "b" },
            })).status,
          ).toBe(200)
          expect(
            (yield* post(`${url}/input`, {
              requestID: "held-steer",
              delivery: "steer",
              text: "steer current task",
              source: { type: "editspace-mail", id: "steer-mail", sender: "b", recipient: "a" },
            })).status,
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
          const messages = yield* requestInDirectory(`${url}/message`, dir)
          const visible = (yield* messages.json) as Array<{
            info: { source?: unknown }
            parts: Array<{ type: string; text?: string }>
          }>
          expect(
            visible.find((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "steer current task"),
            )?.info.source,
          ).toEqual({ type: "editspace-mail", id: "steer-mail", sender: "b", recipient: "a" })
          expect(
            visible.find((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "queued next task"),
            )?.info.source,
          ).toEqual({ type: "editspace-mail", id: "queue-mail", sender: "a", recipient: "b" })
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
          expect((yield* post("input/after-structured/handle", { disposition: "acknowledged" })).status).toBe(409)
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

const DeliverResult = Schema.Struct({ outcome: Schema.String, receipt: SessionV1.InputReceipt })
const Messages = Schema.Array(SessionV1.WithParts)
type Messages = typeof Messages.Type
const readMessages = (url: string, dir: string) =>
  requestInDirectory(`${url}/message`, dir).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Messages)),
  )
const bashPart = (messages: Messages) =>
  messages.flatMap((message) => message.parts).find(
    (part): part is Extract<Messages[number]["parts"][number], { type: "tool" }> => part.type === "tool" && part.tool === "bash",
  )
const userTexts = (messages: Messages) =>
  messages.filter((message) => message.info.role === "user")
    .map((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))

it.live(
  "deliver interrupts a long tool, keeps its partial output, and starts the next turn with the waiting steer",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.tool("bash", { command: "printf partial-before-interrupt; sleep 60", description: "Long build" })
          yield* llm.text("acting on the steer")
          const session = yield* Session.use.create({ title: "Deliver steer" })
          const url = `/session/${session.id}`
          const post = (suffix: string, body?: unknown) =>
            requestInDirectory(`${url}/${suffix}`, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
          yield* post("prompt_async", {
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "run the long build" }],
          })
          yield* pollWithTimeout(
            readMessages(url, dir).pipe(Effect.map((messages) => {
              const part = bashPart(messages)
              return part?.state.status === "running" && String(part.state.metadata?.output ?? "").includes("partial-before-interrupt") ? true : undefined
            })),
            "bash did not start streaming output",
            "10 seconds",
          )
          expect((yield* post("input", { requestID: "long-steer", delivery: "steer", text: "stop that, use the cache" })).status).toBe(200)
          // The steer waits for the running tool: it is not promoted on its own.
          yield* Effect.sleep("300 millis")
          expect((yield* readReceipt(`${url}/input/long-steer`, dir)).state).toBe("pending")
          expect(yield* llm.calls).toBe(1)

          const delivered = yield* (yield* post("input/long-steer/deliver")).json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DeliverResult)))
          expect(delivered.outcome).toBe("delivered")
          expect(delivered.receipt.state).not.toBe("pending")
          yield* llm.wait(2)
          const settled = yield* pollWithTimeout(
            readMessages(url, dir).pipe(Effect.map((messages) =>
              messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === "acting on the steer")) ? messages : undefined,
            )),
            "steer turn did not run",
            "10 seconds",
          )
          const part = bashPart(settled)!
          // The shell tool stops its process and records the abort with the output it had.
          expect(part.state.status).toBe("completed")
          if (part.state.status !== "completed") throw new Error("unreachable")
          expect(part.state.output).toContain("partial-before-interrupt")
          expect(part.state.output).toContain("User aborted the command")
          expect(part.state.metadata?.exit).toBeNull()
          const interrupted = settled.find((message) => message.parts.some((item) => item.id === part.id))!
          expect(interrupted.info.role === "assistant" && interrupted.info.error?.name).toBe("MessageAbortedError")
          expect(userTexts(settled)).toEqual(["run the long build", "stop that, use the cache"])
          // The model sees the interrupted call with its partial output, then the steer; nothing is replayed.
          const second = JSON.stringify((yield* llm.inputs)[1])
          expect(second).toContain("partial-before-interrupt")
          expect(second).toContain("stop that, use the cache")

          // Repeating the request interrupts nothing and sends nothing.
          const again = yield* (yield* post("input/long-steer/deliver")).json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DeliverResult)))
          expect(again.outcome).toBe("settled")
          yield* Effect.sleep("300 millis")
          expect(yield* llm.calls).toBe(2)
          expect(userTexts(yield* readMessages(url, dir))).toEqual(["run the long build", "stop that, use the cache"])
        }),
      { config: testProviderConfig },
    ),
  30_000,
)

it.live(
  "deliver runs a steer left pending by an earlier abort, and refuses queued input",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.tool("bash", { command: "sleep 60", description: "Long wait" })
          const session = yield* Session.use.create({ title: "Stranded steer" })
          const url = `/session/${session.id}`
          const post = (suffix: string, body?: unknown) =>
            requestInDirectory(`${url}/${suffix}`, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
          yield* post("prompt_async", {
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "interrupted task" }],
          })
          yield* pollWithTimeout(
            readMessages(url, dir).pipe(Effect.map((messages) => (bashPart(messages)?.state.status === "running" ? true : undefined))),
            "bash did not start",
            "10 seconds",
          )
          yield* post("input", { requestID: "stranded-steer", delivery: "steer", text: "after the stop" })
          yield* post("input", { requestID: "stranded-queue", delivery: "queue", text: "later work" })
          expect((yield* post("abort")).status).toBe(200)
          expect((yield* readReceipt(`${url}/input/stranded-steer`, dir)).state).toBe("pending")

          const queued = yield* (yield* post("input/stranded-queue/deliver")).json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DeliverResult)))
          expect(queued.outcome).toBe("not-steer")
          expect(queued.receipt.state).toBe("pending")

          yield* llm.text("resumed with the steer")
          yield* llm.text("then the queued work")
          const delivered = yield* (yield* post("input/stranded-steer/deliver")).json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DeliverResult)))
          expect(delivered.outcome).toBe("delivered")
          const messages = yield* pollWithTimeout(
            readMessages(url, dir).pipe(Effect.map((messages) =>
              messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === "then the queued work")) ? messages : undefined,
            )),
            "stranded steer did not run",
            "10 seconds",
          )
          // The steer runs first; the queued input keeps its own idle boundary after it.
          expect(userTexts(messages)).toEqual(["interrupted task", "after the stop", "later work"])
          expect(JSON.stringify((yield* llm.inputs)[1])).not.toContain("later work")
          expect(yield* llm.calls).toBe(3)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "input context reaches the model on the promoted message and invalid context is rejected",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("context received")
          const session = yield* Session.use.create({ title: "Context input" })
          const post = (body: unknown) =>
            requestInDirectory(`/session/${session.id}/input`, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          const item = { text: "CONTEXT-MARKER from answer.ts", source: "file", key: "answer.ts" }
          expect((yield* post({ requestID: "too-many", delivery: "steer", text: "x", context: Array(9).fill(item) })).status).toBe(400)
          expect((yield* post({ requestID: "too-long", delivery: "steer", text: "x", context: [{ ...item, text: "y".repeat(4097) }] })).status).toBe(400)
          expect((yield* post({ requestID: "extra", delivery: "steer", text: "x", context: [{ ...item, extra: 1 }] })).status).toBe(400)

          const admitted = yield* post({ requestID: "with-context", delivery: "steer", agent: "build", text: "use it", context: [item] })
          expect(admitted.status).toBe(200)
          yield* llm.wait(1)
          expect(JSON.stringify(yield* llm.inputs)).toContain("CONTEXT-MARKER from answer.ts")
          const receipt = yield* pollWithTimeout(
            readReceipt(`/session/${session.id}/input/with-context`, dir).pipe(
              Effect.map((value) => (value.state === "pending" ? undefined : value)),
            ),
            "context input was not promoted",
            "10 seconds",
          )
          expect(receipt).toMatchObject({ context: [item] })
        }),
      { config: testProviderConfig },
    ),
  30_000,
)

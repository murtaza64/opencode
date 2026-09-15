import { afterEach, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Logger, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Question } from "@/question"
import { SessionAside } from "@/session/aside"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffectShared(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(
      LayerNode.group([
        Session.node,
        SessionStatus.node,
        InstanceStore.node,
        CrossSpawnSpawner.node,
        Provider.node,
        SessionAside.node,
        EventV2Bridge.node,
      ]),
      [[InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })]],
    ),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const post = (directory: string, path: string, body: unknown) =>
  requestInDirectory(path, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const aside = (directory: string, sessionID: string, requestID = "aside-test", question = "Explain the snapshot") =>
  post(directory, `/session/${sessionID}/aside`, {
    requestID,
    question,
    model: { providerID: "test", modelID: "test-model" },
  })

const writeUser = Effect.fn("test.writeAsideUser")(function* (parent: Session.Info, created: number, text: string) {
  const session = yield* Session.Service
  const info: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "user",
    agent: "build",
    time: { created },
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
  }
  yield* session.updateMessage(info)
  yield* session.updatePart({ id: PartID.ascending(), sessionID: parent.id, messageID: info.id, type: "text", text })
  return info
})

const writeAssistant = Effect.fn("test.writeAsideAssistant")(function* (
  parent: Session.Info,
  parentID: MessageID,
  input: { created: number; completed?: number; summary?: boolean; text: string },
) {
  const session = yield* Session.Service
  const info: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "assistant",
    parentID,
    agent: input.summary ? "compaction" : "build",
    mode: input.summary ? "compaction" : "build",
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: input.created, ...(input.completed === undefined ? {} : { completed: input.completed }) },
    path: { cwd: parent.directory, root: parent.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(input.summary ? { summary: true } : {}),
    ...(input.completed === undefined ? {} : { finish: "stop" }),
  }
  yield* session.updateMessage(info)
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: parent.id,
    messageID: info.id,
    type: "text",
    text: input.text,
  })
  return info
})

it.live("untrusted compaction markers cannot reorder a previous trusted retained tail", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ title: "Two compactions" })
      const retained = yield* writeUser(parent, 1, "Newer retained correction")
      yield* writeAssistant(parent, retained.id, { created: 2, completed: 3, text: "Retained correction answer" })
      const previous = yield* writeUser(parent, 4, "Previous compaction request")
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: previous.id,
        type: "compaction",
        auto: true,
        tail_start_id: retained.id,
      })
      yield* writeAssistant(parent, previous.id, {
        created: 5,
        completed: 6,
        summary: true,
        text: "Previous trusted summary",
      })
      const newest = yield* writeUser(parent, 7, "Newest compaction request")
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: newest.id,
        type: "compaction",
        auto: true,
        tail_start_id: retained.id,
      })
      yield* writeAssistant(parent, newest.id, {
        created: 8,
        completed: 9,
        summary: true,
        text: "Newest unfinalized summary",
      })
      const before = yield* session.messages({ sessionID: parent.id })
      yield* llm.text("Preserved correction order")
      const response = yield* aside(directory, parent.id)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ snapshot: { throughMessageID: newest.id, excludedMessageCount: 1 } })
      const input = JSON.stringify((yield* llm.inputs)[0])
      expect(input).toContain("Previous trusted summary")
      expect(input).toContain("Newer retained correction")
      expect(input).toContain("Retained correction answer")
      expect(input.indexOf("Previous trusted summary")).toBeLessThan(input.indexOf("Newer retained correction"))
      expect(input).not.toContain("Newest unfinalized summary")
      expect(yield* session.messages({ sessionID: parent.id })).toEqual(before)
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("completed failed compaction does not exclude later successful ordinary turns", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ title: "Recovered failed compaction" })
      const user = yield* writeUser(parent, 1, "Original context")
      yield* writeAssistant(parent, user.id, { created: 2, completed: 3, text: "Original answer" })
      const compact = yield* writeUser(parent, 4, "Failed compaction request")
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: compact.id,
        type: "compaction",
        auto: true,
        tail_start_id: user.id,
      })
      const failed = yield* writeAssistant(parent, compact.id, {
        created: 5,
        completed: 6,
        summary: true,
        text: "Partial failed summary",
      })
      yield* session.updateMessage({
        ...failed,
        finish: "error",
        error: new SessionV1.ContextOverflowError({ message: "Compaction failed" }).toObject(),
      })
      const recovered = yield* writeUser(parent, 7, "Recovered question")
      const answer = yield* writeAssistant(parent, recovered.id, {
        created: 8,
        completed: 9,
        text: "Recovered ordinary answer",
      })
      const before = yield* session.messages({ sessionID: parent.id })
      yield* llm.text("Recovery remains visible")
      const response = yield* aside(directory, parent.id)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ snapshot: { throughMessageID: answer.id, excludedMessageCount: 0 } })
      const input = JSON.stringify((yield* llm.inputs)[0])
      expect(input).toContain("Original context")
      expect(input).toContain("Recovered question")
      expect(input).toContain("Recovered ordinary answer")
      expect(input).toContain("[Failed assistant response omitted]")
      expect(input).not.toContain("Partial failed summary")
      expect(yield* session.messages({ sessionID: parent.id })).toEqual(before)
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

const holdParent = Effect.fn("test.holdParent")(function* (directory: string) {
  const llm = yield* TestLLMServer
  yield* llm.tool("question", {
    questions: [
      {
        question: "Parent tool is held",
        header: "Hold",
        options: [{ label: "Continue", description: "Release" }],
      },
    ],
  })
  const response = yield* post(directory, "/session", { title: "Held parent" })
  const parent = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session.Info)))
  yield* Effect.addFinalizer(() =>
    requestInDirectory(`/session/${parent.id}/abort`, directory, { method: "POST" }).pipe(Effect.ignore),
  )
  expect(
    (yield* post(directory, `/session/${parent.id}/prompt_async`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: "Parent task" }],
    })).status,
  ).toBe(204)
  const question = yield* pollWithTimeout(
    requestInDirectory("/question", directory).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Question.Request))),
      Effect.map((items) => items.find((item) => item.sessionID === parent.id)),
    ),
    "Parent did not reach its real question tool",
    "20 seconds",
  )
  const transcript = yield* requestInDirectory(`/session/${parent.id}/message`, directory).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
  )
  const info = yield* requestInDirectory(`/session/${parent.id}`, directory).pipe(
    Effect.flatMap((response) => response.json),
  )
  return { parent, question, transcript, info }
})

const expectParentHeld = Effect.fn("test.expectParentHeld")(function* (
  directory: string,
  held: Effect.Success<ReturnType<typeof holdParent>>,
) {
  expect(
    yield* requestInDirectory(`/session/${held.parent.id}/message`, directory).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
    ),
  ).toEqual(held.transcript)
  expect(
    yield* requestInDirectory(`/session/${held.parent.id}`, directory).pipe(
      Effect.flatMap((response) => response.json),
    ),
  ).toEqual(held.info)
  expect(
    yield* requestInDirectory("/session/status", directory).pipe(Effect.flatMap((response) => response.json)),
  ).toMatchObject({ [held.parent.id]: { type: "busy" } })
  expect(yield* requestInDirectory("/question", directory).pipe(Effect.flatMap((response) => response.json))).toEqual([
    held.question,
  ])
})

const releaseParent = Effect.fn("test.releaseParent")(function* (
  directory: string,
  held: Effect.Success<ReturnType<typeof holdParent>>,
) {
  const llm = yield* TestLLMServer
  yield* llm.text("Parent completed after release")
  expect((yield* post(directory, `/question/${held.question.id}/reply`, { answers: [["Continue"]] })).status).toBe(200)
  const messages = yield* pollWithTimeout(
    requestInDirectory(`/session/${held.parent.id}/message`, directory).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
      Effect.map((messages) =>
        messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.info.time.completed !== undefined &&
            message.parts.some((part) => part.type === "text" && part.text === "Parent completed after release"),
        )
          ? messages
          : undefined,
      ),
    ),
    "Parent did not complete after releasing its held tool",
  )
  expect(
    messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "question"),
  ).toMatchObject({ state: { status: "completed" } })
  yield* pollWithTimeout(
    requestInDirectory("/session/status", directory).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, SessionStatus.Info))),
      Effect.map((statuses) => (statuses[held.parent.id] === undefined ? true : undefined)),
    ),
    "Parent did not become idle after completion",
  )
})

const observeProvider = Effect.fn("test.observeProvider")(function* () {
  const directory = yield* tmpdirScoped()
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Observe socket closure independently of Bun's node:http compatibility.
  const child = yield* spawner.spawn(
    ChildProcess.make("node", [
      "-e",
      `
    const { createServer } = require("node:http")
    const { writeFileSync, renameSync } = require("node:fs")
    const directory = ${JSON.stringify(directory)}
    let count = 0
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      writeFileSync(directory + "/input.tmp", JSON.stringify({ count: ++count, headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) }))
      renameSync(directory + "/input.tmp", directory + "/input.json")
      response.on("close", () => writeFileSync(directory + "/closed", "closed"))
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write('data: {"id":"chatcmpl-held","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}\\n\\n')
      writeFileSync(directory + "/started", "started")
    })
    server.listen(0, "127.0.0.1", () => console.log(server.address().port))
  `,
    ]),
  )
  const port = yield* child.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead)
  return {
    url: `http://127.0.0.1:${Option.getOrThrow(port)}/v1`,
    started: pollWithTimeout(
      Effect.promise(() => Bun.file(path.join(directory, "started")).exists()).pipe(
        Effect.map((exists) => (exists ? true : undefined)),
      ),
      "Aside provider did not start",
    ),
    closed: pollWithTimeout(
      Effect.promise(() => Bun.file(path.join(directory, "closed")).exists()).pipe(
        Effect.map((exists) => (exists ? true : undefined)),
      ),
      "Aside provider socket did not close",
    ),
    input: Effect.promise(() => Bun.file(path.join(directory, "input.json")).text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
    ),
  }
})

it.live("aside correlates its response without changing the parent", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.text("Snapshot answer")
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const status = yield* SessionStatus.Service
      const parent = yield* session.create({ title: "Parent" })
      const before = yield* session.messages({ sessionID: parent.id })
      const response = yield* requestInDirectory(`/session/${parent.id}/aside`, directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestID: "aside-test-1",
          question: "Explain the snapshot",
          model: { providerID: "test", modelID: "test-model" },
        }),
      })
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        requestID: "aside-test-1",
        text: "Snapshot answer",
        snapshot: { capturedAt: expect.any(Number), excludedMessageCount: 0, activity: { status: "idle", tools: [] } },
      })
      expect(yield* session.messages({ sessionID: parent.id })).toEqual(before)
      expect(yield* session.get(parent.id)).toEqual(parent)
      expect(yield* status.get(parent.id)).toEqual({ type: "idle" })
      expect(yield* llm.calls).toBe(1)
      expect((yield* llm.inputs)[0]?.tools).toBeUndefined()
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live(
  "aside completes while a real parent tool remains held",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
      const held = yield* holdParent(directory)
      yield* llm.text("The parent is waiting; this is snapshot-only advice")
      const response = yield* aside(directory, held.parent.id, "concurrent-aside")
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        requestID: "concurrent-aside",
        text: "The parent is waiting; this is snapshot-only advice",
        snapshot: { throughMessageID: held.transcript[0]?.info.id, excludedMessageCount: 1 },
      })
      yield* expectParentHeld(directory, held)
      const input = (yield* llm.inputs).at(-1)
      expect(input?.tools).toBeUndefined()
      expect(JSON.stringify(input)).toContain("Parent task")
      expect(JSON.stringify(input)).not.toContain("Parent tool is held")
      expect(JSON.stringify(input)).not.toContain("Tool execution aborted")
      yield* releaseParent(directory, held)
    }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
  { timeout: 30_000 },
)

it.live(
  "aside failures and forbidden tool calls leave the real parent active without retrying",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
      const held = yield* holdParent(directory)
      const calls = yield* llm.calls
      yield* llm.error(503, { error: { message: "Fixture unavailable" } })
      const failure = yield* aside(directory, held.parent.id)
      expect(failure.status).toBe(400)
      expect(yield* failure.json).toMatchObject({ _tag: "AsideError", message: expect.any(String) })
      expect(yield* llm.calls).toBe(calls + 1)
      yield* expectParentHeld(directory, held)

      yield* llm.tool("question", {
        questions: [
          {
            question: "Must never execute",
            header: "Aside",
            options: [{ label: "Unsafe", description: "Never" }],
          },
        ],
      })
      const tool = yield* aside(directory, held.parent.id)
      expect(tool.status).toBe(400)
      expect(yield* tool.json).toEqual({ _tag: "AsideError", message: "Aside provider attempted a tool call" })
      expect(yield* llm.calls).toBe(calls + 2)
      yield* expectParentHeld(directory, held)

      yield* llm.push(reply().text("Not a complete answer").toolCalls())
      const finish = yield* aside(directory, held.parent.id)
      expect(finish.status).toBe(400)
      expect(yield* finish.json).toEqual({ _tag: "AsideError", message: "Aside provider attempted a tool call" })
      expect(yield* llm.calls).toBe(calls + 3)
      yield* expectParentHeld(directory, held)
      yield* releaseParent(directory, held)
    }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
  { timeout: 30_000 },
)

it.live(
  "SDK signal cancellation closes aside provider transport and leaves the parent tool active",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const provider = yield* observeProvider()
      const config = testProviderConfig(llm.url)
      const directory = yield* tmpdirScoped({
        config: {
          ...config,
          provider: {
            ...config.provider,
            observed: {
              ...config.provider.test,
              id: "observed",
              options: { apiKey: "fixture-key", baseURL: provider.url },
            },
          },
        },
      })
      const held = yield* holdParent(directory)
      const calls = yield* llm.calls
      const client = createOpencodeClient({
        baseUrl: "http://localhost",
        directory,
        fetch: Object.assign(
          (input: RequestInfo | URL, init?: RequestInit) =>
            HttpApiApp.webHandler().handler(new Request(input, init), HttpApiApp.context),
          { preconnect: fetch.preconnect },
        ),
      })
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      )
      const pending = yield* Effect.tryPromise(() =>
        client.session.aside(
          {
            sessionID: held.parent.id,
            requestID: "cancelled-aside",
            question: "Explain",
            model: { providerID: "observed", modelID: "test-model" },
          },
          {
            signal: controller.signal,
            throwOnError: true,
          },
        ),
      ).pipe(Effect.forkScoped)
      yield* provider.started
      yield* Effect.sync(() => controller.abort())
      expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true)
      yield* provider.closed
      expect(yield* provider.input).not.toHaveProperty("headers.x-parent-session-id")
      expect(yield* provider.input).not.toHaveProperty("body.tools")
      yield* expectParentHeld(directory, held)
      yield* llm.text("A separate request still works")
      const next = yield* aside(directory, held.parent.id, "after-cancel")
      expect(next.status).toBe(200)
      expect(yield* next.json).toMatchObject({ requestID: "after-cancel", text: "A separate request still works" })
      expect(yield* llm.calls).toBe(calls + 1)
      yield* expectParentHeld(directory, held)
      yield* releaseParent(directory, held)
    }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
  { timeout: 30_000 },
)

it.live("aside rejects missing sessions, blank questions, and unknown agents or models", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    const missing = yield* aside(directory, SessionID.descending())
    expect(missing.status).toBe(404)
    const created = yield* post(directory, "/session", { title: "Validation" })
    const parent = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session.Info)))
    const blank = yield* aside(directory, parent.id, "blank", "   ")
    expect(blank.status).toBe(400)
    expect(yield* blank.json).toEqual({ _tag: "AsideError", message: "Aside question must not be blank" })
    const agent = yield* post(directory, `/session/${parent.id}/aside`, {
      requestID: "bad-agent",
      question: "Question",
      agent: "does-not-exist",
    })
    expect(agent.status).toBe(400)
    expect(yield* agent.json).toEqual({ _tag: "AsideError", message: "Aside agent not found" })
    const model = yield* post(directory, `/session/${parent.id}/aside`, {
      requestID: "bad-model",
      question: "Question",
      model: { providerID: "test", modelID: "does-not-exist" },
    })
    expect(model.status).toBe(400)
    expect(yield* model.json).toEqual({ _tag: "AsideError", message: "Aside model not found" })
    expect(yield* llm.calls).toBe(0)
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live(
  "explicit TCP cancellation closes only the matching aside and preserves parent continuation",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const provider = yield* observeProvider()
      const config = testProviderConfig(llm.url)
      const directory = yield* tmpdirScoped({
        config: {
          ...config,
          provider: {
            ...config.provider,
            observed: {
              ...config.provider.test,
              id: "observed",
              options: { apiKey: "fixture-key", baseURL: provider.url },
            },
          },
        },
      })
      const held = yield* holdParent(directory)
      const server = yield* HttpServer.HttpServer
      const baseUrl = HttpServer.formatAddress(server.address)
      const client = createOpencodeClient({ baseUrl, directory })
      const parameters = {
        sessionID: held.parent.id,
        requestID: "tcp-cancel",
        question: "Explain",
        model: { providerID: "observed", modelID: "test-model" },
      }
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => client.session.cancelAside({ sessionID: held.parent.id, requestID: "tcp-cancel" })).pipe(
          Effect.ignore,
        ),
      )
      const pending = yield* Effect.promise(() => client.session.aside(parameters)).pipe(Effect.forkScoped)
      yield* provider.started
      const other = yield* post(directory, "/session", { title: "Unrelated parent" })
      const unrelated = yield* other.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session.Info)))
      const wrong = yield* Effect.promise(() =>
        client.session.cancelAside({ sessionID: unrelated.id, requestID: "tcp-cancel" }),
      )
      expect(wrong.response.status).toBe(200)
      expect(wrong.data).toBe(false)
      const duplicate = yield* aside(directory, held.parent.id, "tcp-cancel")
      expect(duplicate.status).toBe(400)
      expect(yield* duplicate.json).toEqual({ _tag: "AsideError", message: "Aside request is already active" })
      yield* expectParentHeld(directory, held)
      const cancelled = yield* Effect.promise(() =>
        client.session.cancelAside({ sessionID: held.parent.id, requestID: "tcp-cancel" }),
      )
      expect(cancelled.response.status).toBe(200)
      expect(cancelled.data).toBe(true)
      const result = yield* Fiber.join(pending)
      expect(result.response.status).toBe(400)
      expect(result.error).toMatchObject({ message: "Aside cancelled" })
      yield* provider.closed
      const retry = yield* aside(directory, held.parent.id, "tcp-cancel")
      expect(retry.status).toBe(400)
      expect(yield* retry.json).toEqual({ _tag: "AsideError", message: "Aside cancelled" })
      yield* expectParentHeld(directory, held)
      yield* releaseParent(directory, held)
    }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
  { timeout: 30_000 },
)

it.live("pre-cancelled TCP request IDs never start inference and remain session-scoped", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    const created = yield* post(directory, "/session", { title: "Pre-cancel" })
    const parent = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session.Info)))
    const cancel = yield* requestInDirectory(`/session/${parent.id}/aside/pre-cancel`, directory, { method: "DELETE" })
    expect(cancel.status).toBe(200)
    expect(yield* cancel.json).toBe(false)
    const response = yield* aside(directory, parent.id, "pre-cancel")
    expect(response.status).toBe(400)
    expect(yield* response.json).toEqual({ _tag: "AsideError", message: "Aside cancelled" })
    expect(yield* llm.calls).toBe(0)
    const other = yield* post(directory, "/session", { title: "Different session" })
    const unrelated = yield* other.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session.Info)))
    yield* llm.text("Independent request")
    const independent = yield* aside(directory, unrelated.id, "pre-cancel")
    expect(independent.status).toBe(200)
    expect(yield* independent.json).toMatchObject({ text: "Independent request" })
    expect(yield* llm.calls).toBe(1)
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("aside cancellation tombstones are bounded and expire after 60 seconds", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const service = yield* SessionAside.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Cancellation capacity" })
      yield* Effect.forEach(
        Array.from({ length: 1024 }, (_, index) => `cancel-${index}`),
        (requestID) => service.cancel(parent.id, requestID),
        { discard: true },
      )
      expect(yield* service.cancel(parent.id, "overflow").pipe(Effect.flip)).toMatchObject({
        message: "Aside cancellation capacity reached",
      })
      expect(
        yield* service.ask(parent.id, { requestID: "cancel-0", question: "Explain" }).pipe(Effect.flip),
      ).toMatchObject({ message: "Aside cancelled" })
      expect(yield* llm.calls).toBe(0)
      yield* TestClock.adjust("60 seconds")
      expect(yield* service.cancel(parent.id, "overflow")).toBe(false)
      yield* llm.text("Expired cancellation does not claim the request forever")
      const result = yield* service.ask(parent.id, {
        requestID: "cancel-0",
        question: "Explain",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      })
      expect(result.text).toBe("Expired cancellation does not claim the request forever")
    }).pipe(provideInstanceEffect(directory), Effect.provide(TestClock.layer()))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live(
  "aside active requests are independently bounded and release slots after cancellation",
  () =>
    Effect.gen(function* () {
      const provider = yield* observeProvider()
      const directory = yield* tmpdirScoped({ config: testProviderConfig(provider.url) })
      yield* Effect.gen(function* () {
        const service = yield* SessionAside.Service
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Active capacity" })
        const ids = Array.from({ length: 32 }, (_, index) => `active-${index}`)
        const pending = yield* Effect.forEach(ids, (requestID) =>
          service
            .ask(parent.id, {
              requestID,
              question: "Explain",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
            })
            .pipe(Effect.flip, Effect.forkScoped),
        )
        yield* provider.started
        yield* pollWithTimeout(
          provider.input.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Number }))),
            Effect.map((input) => (input.count === 32 ? true : undefined)),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
          "All 32 admitted Aside requests did not start",
        )
        expect(
          yield* service.ask(parent.id, { requestID: "overflow", question: "Explain" }).pipe(Effect.flip),
        ).toMatchObject({ message: "Too many active Aside requests" })
        yield* Effect.forEach(ids, (requestID) => service.cancel(parent.id, requestID), { discard: true })
        expect((yield* Effect.forEach(pending, Fiber.join)).map((error) => error.message)).toEqual(
          Array(32).fill("Aside cancelled"),
        )
        expect(yield* service.ask(parent.id, { requestID: "new-slot", question: " " }).pipe(Effect.flip)).toMatchObject(
          { message: "Aside question must not be blank" },
        )
        expect(yield* sessions.messages({ sessionID: parent.id })).toEqual([])
      }).pipe(provideInstanceEffect(directory))
    }),
  { timeout: 30_000 },
)

it.live(
  "aside times out after 60 seconds, closes transport, and leaves the parent resumable",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const provider = yield* observeProvider()
      const config = testProviderConfig(llm.url)
      const directory = yield* tmpdirScoped({
        config: {
          ...config,
          provider: {
            ...config.provider,
            observed: {
              ...config.provider.test,
              id: "observed",
              options: { apiKey: "fixture-key", baseURL: provider.url },
            },
          },
        },
      })
      const held = yield* holdParent(directory)
      const response = yield* post(directory, `/session/${held.parent.id}/aside`, {
        requestID: "timeout-aside",
        question: "Explain",
        model: { providerID: "observed", modelID: "test-model" },
      })
      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ _tag: "AsideError", message: "Aside timed out after 60 seconds" })
      yield* provider.closed
      yield* expectParentHeld(directory, held)
      yield* releaseParent(directory, held)
    }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
  { timeout: 80_000 },
)

it.live("aside rejects GitLab workflow models before changing shared execution state", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({
      init: (directory) =>
        Effect.promise(async () => {
          await Bun.write(
            path.join(directory, "provider.mjs"),
            `
          import { GitLabWorkflowLanguageModel } from ${JSON.stringify(import.meta.resolve("gitlab-ai-provider"))}
          const language = new GitLabWorkflowLanguageModel("duo-workflow", {
            provider: "fixture", instanceUrl: "http://127.0.0.1:1", getHeaders: () => ({})
          })
          export const createFixture = () => ({ languageModel: () => language })
        `,
          )
          const config = testProviderConfig("http://127.0.0.1:1")
          await Bun.write(
            path.join(directory, "opencode.json"),
            JSON.stringify({
              ...config,
              provider: {
                test: { ...config.provider.test, npm: pathToFileURL(path.join(directory, "provider.mjs")).href },
              },
            }),
          )
        }),
    })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const provider = yield* Provider.Service
      const parent = yield* session.create({ title: "Workflow parent" })
      const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
      const language = yield* provider.getLanguage(model)
      if (!(language instanceof GitLabWorkflowLanguageModel))
        return yield* Effect.die("Fixture must load the real workflow class")
      language.sessionID = parent.id
      language.systemPrompt = "Parent system"
      language.sessionPreapprovedTools = ["parent-only"]
      language.toolExecutor = async () => ({ result: "Parent tool" })
      language.approvalHandler = async () => ({ approved: false })
      const before = {
        sessionID: language.sessionID,
        system: language.systemPrompt,
        tools: language.sessionPreapprovedTools,
        execute: language.toolExecutor,
        approve: language.approvalHandler,
      }
      const response = yield* aside(directory, parent.id)
      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({
        _tag: "AsideError",
        message: "Aside does not support GitLab workflow models",
      })
      expect({
        sessionID: language.sessionID,
        system: language.systemPrompt,
        tools: language.sessionPreapprovedTools,
        execute: language.toolExecutor,
        approve: language.approvalHandler,
      }).toEqual(before)
      expect(yield* session.get(parent.id)).toEqual(parent)
      expect(yield* session.messages({ sessionID: parent.id })).toEqual([])
    }).pipe(provideInstanceEffect(directory))
  }),
)

it.live("aside materializes only completed text and excludes unfinished output and its later tail", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ title: "Snapshot" })
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "user",
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        time: { created: 1 },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: user.id,
        type: "text",
        text: "Stable question",
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: user.id,
        type: "file",
        mime: "image/png",
        url: "https://unavailable.invalid/never-fetch.png",
      })
      const completed: SessionV1.Assistant = {
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "assistant",
        parentID: user.id,
        agent: "build",
        mode: "build",
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 2, completed: 3 },
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      }
      yield* session.updateMessage(completed)
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: completed.id,
        type: "text",
        text: "Stable answer",
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: completed.id,
        type: "tool",
        tool: "read",
        callID: "old-tool",
        state: {
          status: "completed",
          input: { secret: "omitted tool input" },
          output: "omitted tool output",
          title: "Read",
          metadata: {},
          time: { start: 2, end: 3 },
        },
      })
      const unfinished = { ...completed, id: MessageID.ascending(), time: { created: 4 }, finish: undefined }
      yield* session.updateMessage(unfinished)
      const partial = yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: unfinished.id,
        type: "text",
        text: "Mutable partial output",
      })
      yield* session.updateMessage({ ...user, id: MessageID.ascending(), time: { created: 5 } })
      yield* llm.text("Snapshot only")
      const before = yield* session.messages({ sessionID: parent.id })
      const response = yield* aside(directory, parent.id, "projection")
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        snapshot: { throughMessageID: completed.id, excludedMessageCount: 2 },
      })
      expect(yield* session.messages({ sessionID: parent.id })).toEqual(before)
      const input = JSON.stringify((yield* llm.inputs)[0])
      expect(input).toContain("Stable question")
      expect(input).toContain("Stable answer")
      expect(input).toContain("file omitted; unavailable to Aside")
      expect(input).toContain("input and output omitted")
      expect(input).not.toContain("never-fetch.png")
      expect(input).not.toContain("omitted tool input")
      expect(input).not.toContain("omitted tool output")
      expect(input).not.toContain("Mutable partial output")
      expect(input).not.toContain("Tool execution aborted")

      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* llm.hold("Frozen before completion", release.promise)
      const pending = yield* aside(directory, parent.id, "frozen").pipe(Effect.forkScoped)
      yield* llm.wait(2)
      yield* session.updatePart({ ...partial, type: "text", text: "Completed after capture" })
      yield* session.updateMessage({ ...unfinished, time: { created: 4, completed: 6 }, finish: "stop" })
      yield* Effect.sync(() => release.resolve())
      const frozen = yield* Fiber.join(pending)
      expect(frozen.status).toBe(200)
      expect(yield* frozen.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionAside.Result)))).toMatchObject({
        requestID: "frozen",
        snapshot: { throughMessageID: completed.id, excludedMessageCount: 2 },
      })
      expect(JSON.stringify((yield* llm.inputs)[1])).not.toContain("Completed after capture")
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live(
  "aside skips execution hooks and parent agent instructions",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({
        init: (directory) =>
          Effect.promise(async () => {
            await Bun.write(
              path.join(directory, "hooks.js"),
              `
          export default async () => ({
            "experimental.chat.system.transform": () => { throw new Error("system execution hook ran") },
            "chat.params": () => { throw new Error("params execution hook ran") },
            "chat.headers": () => { throw new Error("headers execution hook ran") },
            "chat.message": () => { throw new Error("message execution hook ran") },
            "tool.execute.before": () => { throw new Error("tool execution hook ran") },
          })
        `,
            )
            await Bun.write(
              path.join(directory, "opencode.json"),
              JSON.stringify({
                ...testProviderConfig(llm.url),
                plugin: [pathToFileURL(path.join(directory, "hooks.js")).href],
                agent: { build: { prompt: "Parent execution instructions must not be inherited" } },
              }),
            )
          }),
      })
      const created = yield* post(directory, "/session", { title: "Hooks" })
      const parent = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session.Info)))
      yield* llm.text("No execution hooks")
      const response = yield* aside(directory, parent.id)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ text: "No execution hooks" })
      const input = JSON.stringify((yield* llm.inputs)[0])
      expect(input).not.toContain("Parent execution instructions must not be inherited")
      expect(input).toContain("Never grant approval")
      // Prove the plugin was loaded: the ordinary prompt path must still run its hook.
      const prompt = yield* post(directory, `/session/${parent.id}/message`, {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "Normal prompt" }],
      })
      expect(prompt.status).not.toBe(200)
      expect(yield* llm.calls).toBe(1)
    }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
  { timeout: 30_000 },
)

it.live("aside uses saved compaction context instead of replaying superseded history", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ title: "Compacted snapshot" })
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "user",
        agent: "build",
        time: { created: 1 },
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: user.id,
        type: "text",
        text: "Superseded history",
      })
      const compact = yield* session.updateMessage({ ...user, id: MessageID.ascending(), time: { created: 2 } })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: compact.id,
        type: "compaction",
        auto: true,
      })
      const summary = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "assistant",
        parentID: compact.id,
        agent: "compaction",
        mode: "compaction",
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 3, completed: 4 },
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        summary: true,
        finish: "stop",
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: summary.id,
        type: "text",
        text: "Saved compaction summary",
      })
      yield* writeAssistant(parent, compact.id, { created: 5, text: "Later provider turn" })
      const before = yield* session.messages({ sessionID: parent.id })
      yield* llm.text("Using the saved summary")
      const response = yield* aside(directory, parent.id)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        snapshot: { throughMessageID: summary.id, excludedMessageCount: 1 },
      })
      const input = JSON.stringify((yield* llm.inputs)[0])
      expect(input).toContain("Saved compaction summary")
      expect(input).not.toContain("Superseded history")
      expect(yield* session.messages({ sessionID: parent.id })).toEqual(before)
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("aside excludes user metadata and parts until an assistant references the user", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ title: "User admission barrier" })
      const user = yield* writeUser(parent, 1, "First half of user input")
      yield* llm.text("No admitted context")
      const response = yield* aside(directory, parent.id)
      expect(yield* response.json).toMatchObject({ snapshot: { excludedMessageCount: 1 } })
      expect(JSON.stringify((yield* llm.inputs)[0])).not.toContain("First half of user input")
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: user.id,
        type: "text",
        text: "Second half",
      })
      yield* writeAssistant(parent, user.id, { created: 2, text: "Partial assistant" })
      const status = yield* SessionStatus.Service
      yield* status.set(parent.id, {
        type: "retry",
        attempt: 1,
        next: Date.now() + 60_000,
        message: "Private retry detail",
      })
      yield* llm.text("The complete user is now admitted")
      const admitted = yield* aside(directory, parent.id)
      expect(yield* admitted.json).toMatchObject({
        snapshot: {
          throughMessageID: user.id,
          excludedMessageCount: 1,
          activity: { status: "retry", tools: [] },
        },
      })
      expect(JSON.stringify((yield* llm.inputs)[1])).toContain("First half of user input")
      expect(JSON.stringify((yield* llm.inputs)[1])).toContain("Second half")
      expect(JSON.stringify((yield* llm.inputs)[1])).not.toContain("Partial assistant")
      expect(JSON.stringify((yield* llm.inputs)[1])).not.toContain("Private retry detail")
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("an unconfirmed noReply user does not hide a later completed turn", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ title: "Unconfirmed historical user" })
      yield* writeUser(parent, 1, "Unconfirmed noReply text")
      const user = yield* writeUser(parent, 2, "Later admitted question")
      const completed = yield* writeAssistant(parent, user.id, {
        created: 3,
        completed: 4,
        text: "Later completed answer",
      })
      yield* llm.text("Stable later context")
      const response = yield* aside(directory, parent.id)
      expect(yield* response.json).toMatchObject({
        snapshot: { throughMessageID: completed.id, excludedMessageCount: 1 },
      })
      const input = JSON.stringify((yield* llm.inputs)[0])
      expect(input).not.toContain("Unconfirmed noReply text")
      expect(input).toContain("Later admitted question")
      expect(input).toContain("Later completed answer")
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("aside preserves retained context between summary completion and tail marker commit", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const status = yield* SessionStatus.Service
      const parent = yield* session.create({ title: "Compaction commit gap" })
      const user = yield* writeUser(parent, 1, "Retained question")
      yield* writeAssistant(parent, user.id, { created: 2, completed: 3, text: "Retained answer" })
      const compact = yield* writeUser(parent, 4, "Compact the conversation")
      const part: SessionV1.CompactionPart = {
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: compact.id,
        type: "compaction",
        auto: true,
      }
      yield* session.updatePart(part)
      const summary = yield* writeAssistant(parent, compact.id, {
        created: 5,
        completed: 6,
        summary: true,
        text: "Unfinalized summary",
      })
      yield* status.set(parent.id, { type: "busy" })
      yield* llm.text("Retained context is still present")
      const response = yield* aside(directory, parent.id)
      expect(response.status).toBe(200)
      const first = JSON.stringify((yield* llm.inputs)[0])
      expect(first).toContain("Retained question")
      expect(first).toContain("Retained answer")
      expect(first).not.toContain("Unfinalized summary")

      yield* status.set(parent.id, { type: "idle" })
      yield* llm.text("Idle alone is not a finalization marker")
      const idle = yield* aside(directory, parent.id)
      expect(idle.status).toBe(200)
      expect(JSON.stringify((yield* llm.inputs)[1])).toContain("Retained question")
      expect(JSON.stringify((yield* llm.inputs)[1])).not.toContain("Unfinalized summary")

      yield* session.updatePart({ ...part, tail_start_id: user.id })
      yield* writeAssistant(parent, compact.id, { created: 7, text: "Next turn is running" })
      yield* status.set(parent.id, { type: "busy" })
      yield* llm.text("Summary and retained tail")
      const finalized = yield* aside(directory, parent.id)
      expect(yield* finalized.json).toMatchObject({
        snapshot: { throughMessageID: summary.id, excludedMessageCount: 1 },
      })
      const next = JSON.stringify((yield* llm.inputs)[2])
      expect(next).toContain("Retained answer")
      expect(next.indexOf("Unfinalized summary")).toBeLessThan(next.indexOf("Retained question"))
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("trusted compaction supersedes a crash orphan before the unfinished cutoff", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ title: "Orphan before compaction" })
      const old = yield* writeUser(parent, 1, "Old task")
      yield* writeAssistant(parent, old.id, { created: 2, text: "Crash orphan output" })
      const retained = yield* writeUser(parent, 3, "Retained tail question")
      yield* writeAssistant(parent, retained.id, { created: 4, completed: 5, text: "Retained tail answer" })
      const compact = yield* writeUser(parent, 6, "Compaction request")
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: compact.id,
        type: "compaction",
        auto: true,
        tail_start_id: retained.id,
      })
      const summary = yield* writeAssistant(parent, compact.id, {
        created: 7,
        completed: 8,
        summary: true,
        text: "Trusted recovery summary",
      })
      yield* writeAssistant(parent, compact.id, { created: 9, text: "Running after recovery" })
      const before = yield* session.messages({ sessionID: parent.id })
      yield* llm.text("Recovered snapshot")
      const response = yield* aside(directory, parent.id)
      expect(yield* response.json).toMatchObject({
        snapshot: { throughMessageID: summary.id, excludedMessageCount: 1 },
      })
      const input = JSON.stringify((yield* llm.inputs)[0])
      expect(input).not.toContain("Crash orphan output")
      expect(input).not.toContain("Running after recovery")
      expect(input).toContain("Retained tail answer")
      expect(input.indexOf("Trusted recovery summary")).toBeLessThan(input.indexOf("Retained tail question"))
      expect(yield* session.messages({ sessionID: parent.id })).toEqual(before)
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("aside reports captured tool activity rather than live activity at response time", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    const held = yield* holdParent(directory)
    const calls = yield* llm.calls
    const release = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
    yield* llm.hold("Activity was captured, not observed live", release.promise)
    const pending = yield* aside(directory, held.parent.id).pipe(Effect.forkScoped)
    yield* llm.wait(calls + 1)
    yield* releaseParent(directory, held)
    yield* Effect.sync(() => release.resolve())
    const response = yield* Fiber.join(pending)
    expect(yield* response.json).toMatchObject({
      snapshot: {
        activity: { status: "busy", tools: [{ name: "question", status: "running" }] },
      },
    })
    const input = JSON.stringify((yield* llm.inputs)[calls])
    expect(input).not.toContain("Parent tool is held")
    expect(input).toContain("snapshot")
    yield* llm.text("The next snapshot is idle")
    const next = yield* aside(directory, held.parent.id)
    expect(yield* next.json).toMatchObject({ snapshot: { activity: { status: "idle", tools: [] } } })
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("aside preserves unexpected provider loader defects at the HTTP error boundary", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({
      init: (directory) =>
        Effect.promise(async () => {
          await Bun.write(
            path.join(directory, "broken.mjs"),
            `
        export const createFixture = () => ({ languageModel: () => { throw new TypeError("fixture programmer defect") } })
      `,
          )
          const config = testProviderConfig(llm.url)
          await Bun.write(
            path.join(directory, "opencode.json"),
            JSON.stringify({
              ...config,
              provider: {
                ...config.provider,
                broken: {
                  ...config.provider.test,
                  id: "broken",
                  npm: pathToFileURL(path.join(directory, "broken.mjs")).href,
                },
              },
            }),
          )
        }),
    })
    const held = yield* holdParent(directory)
    const events = yield* EventV2Bridge.Service
    const errors: unknown[] = []
    yield* Effect.acquireRelease(
      events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Session.Event.Error.type) errors.push(event.data)
        }),
      ),
      (unsubscribe) => unsubscribe,
    )
    const response = yield* post(directory, `/session/${held.parent.id}/aside`, {
      requestID: "defect",
      question: "Explain",
      model: { providerID: "broken", modelID: "test-model" },
    })
    expect(response.status).toBe(500)
    expect(yield* response.json).toMatchObject({
      name: "UnknownError",
      data: { message: "Unexpected server error. Check server logs for details.", ref: expect.any(String) },
    })
    expect(errors).toEqual([])
    yield* expectParentHeld(directory, held)
    yield* releaseParent(directory, held)
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

it.live("aside logs expected provider failures once without raw provider data", () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const directory = yield* tmpdirScoped({ config: testProviderConfig(llm.url) })
    yield* Effect.gen(function* () {
      const session = yield* Session.Service
      const service = yield* SessionAside.Service
      const parent = yield* session.create({ title: "Sanitized provider failure" })
      yield* llm.error(503, { error: { message: "untrusted-provider-body" } })
      const messages: unknown[] = []
      expect(
        yield* service
          .ask(parent.id, {
            requestID: "provider-failure",
            question: "Explain",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          })
          .pipe(
            Effect.flip,
            Effect.provide(
              Logger.layer([
                Logger.make<unknown, void>((options) => {
                  messages.push(options.message)
                }),
              ]),
            ),
          ),
      ).toMatchObject({ message: "Aside provider request failed" })
      expect(JSON.stringify(messages)).not.toContain("untrusted-provider-body")
      expect(messages.filter((item) => Array.isArray(item) && item[0] === "aside provider request failed")).toEqual([
        ["aside provider request failed", { category: "api", providerID: "test", modelID: "test-model" }],
      ])
    }).pipe(provideInstanceEffect(directory))
  }).pipe(Effect.provide(Layer.fresh(TestLLMServer.layer))),
)

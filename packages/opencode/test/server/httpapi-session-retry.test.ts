import { afterEach, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionFailure } from "@/session/failure"
import { MessageID, PartID } from "@/session/schema"
import { disposeAllInstances, provideTmpdirServer, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const SECRET = "provider-secret-body-7f3a"
const allowBash = [{ permission: "bash", pattern: "*", action: "allow" as const }]
const model = { providerID: "test", modelID: "test-model" }

const post = (dir: string, path: string, body: unknown) =>
  requestInDirectory(path, dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const failed = (dir: string) =>
  requestInDirectory("/experimental/session/failed", dir).pipe(
    Effect.flatMap((response) => response.text),
    Effect.map((text) => ({ text, items: Schema.decodeUnknownSync(Schema.Array(SessionFailure.Info))(JSON.parse(text)) })),
  )

const retry = (dir: string, sessionID: string, messageID: string) =>
  post(dir, `/session/${sessionID}/retry`, { messageID }).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => Schema.decodeUnknownSync(SessionFailure.RetryResult)(body)),
  )

const messages = (dir: string, sessionID: string) =>
  requestInDirectory(`/session/${sessionID}/message`, dir).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
  )

const failureOf = (dir: string, sessionID: string, previous?: string) =>
  pollWithTimeout(
    failed(dir).pipe(
      Effect.map((list) => list.items.find((item) => item.sessionID === sessionID && item.messageID !== previous)),
    ),
    "session did not become failed",
    "45 seconds",
  )

const idleWithReply = (dir: string, sessionID: string, text: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = (yield* requestInDirectory("/session/status", dir).pipe(Effect.flatMap((r) => r.json))) as Record<string, { type: string }>
      if (status[sessionID] && status[sessionID].type !== "idle") return undefined
      const history = yield* messages(dir, sessionID)
      const last = history.at(-1)
      return last?.info.role === "assistant" && last.info.finish === "stop" &&
        last.parts.some((part) => part.type === "text" && part.text === text)
        ? history
        : undefined
    }),
    "retry did not finish",
    "45 seconds",
  )

const toolRuns = (dir: string) => Effect.promise(() => Bun.file(path.join(dir, "tool-runs")).text().catch(() => ""))

const seedHistory = Effect.fn("test.seedFailedHistory")(function* (
  session: Session.Info,
  assistant: { error?: SessionV1.Assistant["error"]; tool?: boolean; completed?: boolean; at?: number },
) {
  const sessions = yield* Session.Service
  const user: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    time: { created: Date.now() },
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
  }
  yield* sessions.updateMessage(user)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "seed" })
  const info: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: assistant.at ?? Date.now(), ...(assistant.completed === false ? {} : { completed: assistant.at ?? Date.now() }) },
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(assistant.error ? { error: assistant.error } : assistant.completed === false ? {} : { finish: "stop" }),
  }
  yield* sessions.updateMessage(info)
  if (assistant.tool)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: info.id,
      type: "tool",
      callID: "call_seed",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "printf seeded" },
        output: "seeded",
        title: "bash",
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
      },
    })
  return info
})

const apiError = (statusCode: number): SessionV1.Assistant["error"] =>
  new SessionV1.APIError({ message: SECRET, statusCode, isRetryable: false, responseBody: SECRET }).toObject()

it.live(
  "403 mid-turn failure is listed without provider details and Retry continues without rerunning completed tools",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          // Each real tool execution appends one byte, so the file counts side effects, not history parts.
          yield* llm.tool("bash", { command: "printf x >> tool-runs && printf tool-ran-once", description: "Run once" })
          yield* llm.error(403, { error: { message: SECRET } })
          yield* llm.text("recovered after retry")
          const session = yield* Session.use.create({ title: "Retry boundary", permission: allowBash })
          expect((yield* post(dir, `/session/${session.id}/prompt_async`, {
            agent: "build",
            model,
            parts: [{ type: "text", text: "run the tool then continue" }],
          })).status).toBe(204)

          const failure = yield* failureOf(dir, session.id)
          expect(failure).toMatchObject({
            sessionID: session.id,
            directory: dir,
            error: { name: "APIError", statusCode: 403 },
            retry: "available",
          })
          expect((yield* failed(dir)).text).not.toContain(SECRET)
          expect(yield* llm.inputs).toHaveLength(2)
          expect(yield* toolRuns(dir)).toBe("x")

          expect(yield* retry(dir, session.id, failure.messageID)).toEqual({ outcome: "accepted" })
          const history = yield* idleWithReply(dir, session.id, "recovered after retry")
          const inputs = yield* llm.inputs
          expect(inputs).toHaveLength(3)
          // The replayed request carries the completed tool result and no fabricated prompt.
          expect(JSON.stringify(inputs[2])).toContain("tool-ran-once")
          expect(JSON.stringify(inputs[2])).not.toContain(SECRET)
          expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)
          expect(history.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toHaveLength(1)
          expect(history.some((message) => message.info.id === failure.messageID)).toBe(true)

          expect((yield* failed(dir)).items.some((item) => item.sessionID === session.id)).toBe(false)
          expect(yield* retry(dir, session.id, failure.messageID)).toEqual({ outcome: "stale" })
          expect(yield* llm.inputs).toHaveLength(3)
          expect(yield* toolRuns(dir)).toBe("x")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "concurrent single and bulk retries of one failure start exactly one provider turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.error(403, { error: { message: SECRET } })
          yield* llm.push(reply().text("only once").wait(held.promise).stop())
          const session = yield* Session.use.create({ title: "Race boundary" })
          yield* post(dir, `/session/${session.id}/prompt_async`, { agent: "build", model, parts: [{ type: "text", text: "go" }] })
          const failure = yield* failureOf(dir, session.id)

          const outcomes = yield* Effect.forEach(
            Array.from({ length: 6 }),
            () => retry(dir, session.id, failure.messageID),
            { concurrency: "unbounded" },
          )
          expect(outcomes.filter((item) => item.outcome === "accepted")).toHaveLength(1)
          expect(outcomes.every((item) => ["accepted", "running", "stale"].includes(item.outcome))).toBe(true)
          yield* llm.wait(2)
          // A lost acknowledgment re-sent while the retry runs never starts another turn.
          expect((yield* retry(dir, session.id, failure.messageID)).outcome).toMatch(/^(running|stale)$/)
          held.resolve()
          yield* idleWithReply(dir, session.id, "only once")
          expect(yield* retry(dir, session.id, failure.messageID)).toEqual({ outcome: "stale" })
          expect(yield* llm.inputs).toHaveLength(2)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a retry that fails again stays failed under a new identity and the old identity is stale",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.error(403, { error: { message: SECRET } })
          yield* llm.error(401, { error: { message: SECRET } })
          yield* llm.text("third time")
          const session = yield* Session.use.create({ title: "Failed again" })
          yield* post(dir, `/session/${session.id}/prompt_async`, { agent: "build", model, parts: [{ type: "text", text: "go" }] })
          const first = yield* failureOf(dir, session.id)
          expect(yield* retry(dir, session.id, first.messageID)).toEqual({ outcome: "accepted" })
          const second = yield* failureOf(dir, session.id, first.messageID)
          expect(second.error).toEqual({ name: "APIError", statusCode: 401 })
          const stale = yield* retry(dir, session.id, first.messageID)
          expect(stale.outcome).toBe("stale")
          expect(stale.failed?.messageID).toBe(second.messageID)
          expect(yield* retry(dir, session.id, second.messageID)).toEqual({ outcome: "accepted" })
          const history = yield* idleWithReply(dir, session.id, "third time")
          expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)
          expect(yield* llm.inputs).toHaveLength(3)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a failed step that started a tool is listed as unsafe and never retried",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          // The provider streams a complete tool call, then reports a terminal error in the same step.
          const delta = (value: Record<string, unknown>) => ({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ delta: value }],
          })
          yield* llm.push(raw({
            head: [
              delta({ role: "assistant" }),
              delta({ tool_calls: [{ index: 0, id: "call_unsafe", type: "function", function: { name: "bash", arguments: "" } }] }),
              delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "printf x >> tool-runs", description: "Side effect" }) } }] }),
              { error: { message: SECRET, type: "invalid_request_error", code: "forbidden" } },
            ],
          }))
          const session = yield* Session.use.create({ title: "Unsafe boundary", permission: allowBash })
          yield* post(dir, `/session/${session.id}/prompt_async`, { agent: "build", model, parts: [{ type: "text", text: "go" }] })
          const failure = yield* failureOf(dir, session.id)
          expect(failure.retry).toBe("unsafe")
          expect(failure.error).toEqual({ name: "UnknownError" })
          expect((yield* failed(dir)).text).not.toContain(SECRET)
          const history = yield* messages(dir, session.id)
          expect(history.at(-1)?.parts.find((part) => part.type === "tool")?.state.status).toBe("completed")
          // The provider error aborts the started command, so it may or may not have taken effect.
          const before = yield* toolRuns(dir)
          expect(before.length).toBeLessThanOrEqual(1)
          expect((yield* retry(dir, session.id, failure.messageID)).outcome).toBe("unsafe")
          expect(yield* llm.inputs).toHaveLength(1)
          expect(yield* toolRuns(dir)).toBe(before)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "failure state survives instance disposal and retry still starts from the durable boundary",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.error(403, { error: { message: SECRET } })
          yield* llm.text("after restart")
          const session = yield* Session.use.create({ title: "Restart boundary" })
          yield* post(dir, `/session/${session.id}/prompt_async`, { agent: "build", model, parts: [{ type: "text", text: "go" }] })
          const failure = yield* failureOf(dir, session.id)
          yield* Effect.promise(() => disposeAllInstances())
          expect((yield* failed(dir)).items.find((item) => item.sessionID === session.id)).toEqual(failure)
          expect(yield* retry(dir, session.id, failure.messageID)).toEqual({ outcome: "accepted" })
          yield* idleWithReply(dir, session.id, "after restart")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "aborted, healthy, archived, child, superseded, unsafe-history and interrupted-retry sessions are excluded",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const aborted = yield* sessions.create({ title: "Aborted" })
          const abortedMsg = yield* seedHistory(aborted, {
            error: new SessionV1.AbortedError({ message: "Aborted" }).toObject(),
          })
          const healthy = yield* sessions.create({ title: "Healthy" })
          const healthyMsg = yield* seedHistory(healthy, {})
          const archived = yield* sessions.create({ title: "Archived" })
          const archivedMsg = yield* seedHistory(archived, { error: apiError(403) })
          yield* sessions.setArchived({ sessionID: archived.id, time: Date.now() })
          const parent = yield* sessions.create({ title: "Parent" })
          const child = yield* sessions.create({ title: "Child", parentID: parent.id })
          const childMsg = yield* seedHistory(child, { error: apiError(403) })
          const predecessor = yield* sessions.create({ title: "Predecessor" })
          const predecessorMsg = yield* seedHistory(predecessor, { error: apiError(403) })
          const successor = yield* sessions.create({ title: "Successor" })
          expect((yield* post(dir, `/session/${predecessor.id}/supersede`, { successor: successor.id })).status).toBe(200)
          const unsafe = yield* sessions.create({ title: "Unsafe history" })
          const unsafeMsg = yield* seedHistory(unsafe, { error: apiError(403), tool: true })
          // A crash after the retry wrote its newer step leaves an unfinished step, not a failure.
          const interrupted = yield* sessions.create({ title: "Interrupted retry" })
          const interruptedMsg = yield* seedHistory(interrupted, { error: apiError(403) })
          yield* seedHistory(interrupted, { completed: false })
          const recovered = yield* sessions.create({ title: "Historical failure then success" })
          yield* seedHistory(recovered, { error: apiError(401) })
          yield* seedHistory(recovered, {})

          const list = (yield* failed(dir)).items
          expect(list.map((item) => item.sessionID)).toEqual([unsafe.id])
          expect(list[0]).toMatchObject({ messageID: unsafeMsg.id, retry: "unsafe", error: { name: "APIError", statusCode: 403 } })

          expect((yield* retry(dir, aborted.id, abortedMsg.id)).outcome).toBe("not-failed")
          expect((yield* retry(dir, healthy.id, healthyMsg.id)).outcome).toBe("not-failed")
          expect((yield* retry(dir, archived.id, archivedMsg.id)).outcome).toBe("archived")
          expect((yield* retry(dir, child.id, childMsg.id)).outcome).toBe("child")
          expect((yield* retry(dir, predecessor.id, predecessorMsg.id)).outcome).toBe("superseded")
          expect((yield* retry(dir, unsafe.id, unsafeMsg.id)).outcome).toBe("unsafe")
          expect((yield* retry(dir, interrupted.id, interruptedMsg.id)).outcome).toBe("stale")
          // Routing pins Session routes to the Session's own directory, so a foreign directory query
          // reaches the same runner and the same decision.
          const other = yield* tmpdirScoped()
          const foreign = yield* post(other, `/session/${unsafe.id}/retry`, { messageID: unsafeMsg.id })
          expect(yield* foreign.json).toMatchObject({ outcome: "unsafe" })
          const missing = yield* post(dir, `/session/${"ses_0000000000000000000000missing"}/retry`, { messageID: unsafeMsg.id })
          expect(missing.status).toBe(404)
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a failed step stamped in the future is listed but never retried",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          // Imported history or a clock corrected backwards leaves the failed step ahead of Date.now;
          // every row a retry wrote would sort before it, so the retry could never see its own progress.
          const session = yield* Session.use.create({ title: "Future failure" })
          const failedMsg = yield* seedHistory(session, { error: apiError(403), at: Date.now() + 86_400_000 })
          expect(yield* failureOf(dir, session.id)).toMatchObject({ messageID: failedMsg.id, retry: "out-of-order" })
          expect(yield* retry(dir, session.id, failedMsg.id)).toMatchObject({ outcome: "unsafe", failed: { retry: "out-of-order" } })
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a row written after the failed step makes it stale even when its timestamp sorts earlier",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "Skewed retry row" })
          const failedMsg = yield* seedHistory(session, { error: apiError(403) })
          expect((yield* failureOf(dir, session.id)).messageID).toBe(failedMsg.id)
          // What a retry leaves behind if the clock stepped back after it was accepted: its newer
          // step carries an earlier timestamp, so the failed step still sorts newest by time.
          const sessions = yield* Session.Service
          yield* sessions.updateMessage({ ...failedMsg, id: MessageID.ascending(), error: undefined, finish: "stop",
            time: { created: failedMsg.time.created - 60_000, completed: failedMsg.time.created - 60_000 } })
          expect((yield* messages(dir, session.id)).at(-1)?.info.id).toBe(failedMsg.id)
          expect((yield* failed(dir)).items.some((item) => item.sessionID === session.id)).toBe(false)
          expect((yield* retry(dir, session.id, failedMsg.id)).outcome).toBe("stale")
          yield* Effect.promise(() => disposeAllInstances())
          expect((yield* retry(dir, session.id, failedMsg.id)).outcome).toBe("stale")
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

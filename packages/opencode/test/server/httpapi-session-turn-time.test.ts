import { afterEach, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionInput } from "@/session/input"
import { SessionFailure } from "@/session/failure"
import { MessageID, PartID } from "@/session/schema"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(SessionInput.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const model = { providerID: "test", modelID: "test-model" }

const post = (dir: string, path: string, body?: unknown) =>
  requestInDirectory(path, dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

// Read through the public route, so this is what a client sees after a reload.
const info = (dir: string, sessionID: string) =>
  requestInDirectory(`/session/${sessionID}`, dir).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as { time: { updated: number; turn?: { started?: number; ended?: number } } }),
  )

const settled = (dir: string, sessionID: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = (yield* requestInDirectory("/session/status", dir).pipe(Effect.flatMap((r) => r.json))) as Record<string, { type: string }>
      if (status[sessionID] && status[sessionID].type !== "idle") return undefined
      const current = yield* info(dir, sessionID)
      const turn = current.time.turn
      return turn?.started !== undefined && turn.ended !== undefined ? current : undefined
    }),
    "turn did not settle",
    "45 seconds",
  )

const seedFinished = Effect.fn("test.seedFinishedTurn")(function* (session: Session.Info, assistant: Partial<SessionV1.Assistant> = { finish: "stop" }) {
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
  const now = Date.now()
  const reply: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: now, completed: now },
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...assistant,
  }
  yield* sessions.updateMessage(reply)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: reply.id, type: "text", text: "done" })
  return reply
})

it.live(
  "a prompt records one turn start and its end, and both survive a reload",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("first reply")
          const session = yield* Session.use.create({ title: "Prompt turn" })
          expect((yield* info(dir, session.id)).time.turn).toBeUndefined()
          const before = Date.now()
          expect((yield* post(dir, `/session/${session.id}/prompt_async`, { agent: "build", model, parts: [{ type: "text", text: "go" }] })).status).toBe(204)
          const after = yield* settled(dir, session.id)
          const turn = after.time.turn!
          expect(turn.started!).toBeGreaterThanOrEqual(before)
          expect(turn.ended!).toBeGreaterThanOrEqual(turn.started!)
          yield* Effect.promise(() => disposeAllInstances())
          expect((yield* info(dir, session.id)).time.turn).toEqual(turn)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "noReply, shell and an empty wake record no turn and start no provider call",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "Record only" })
          const response = yield* post(dir, `/session/${session.id}/message`, { agent: "build", model, noReply: true, parts: [{ type: "text", text: "note" }] })
          expect(response.status).toBe(200)
          expect((yield* info(dir, session.id)).time.turn).toBeUndefined()
          // A shell command and an advisory wake with nothing to promote run the runner without the provider.
          const shell = yield* post(dir, `/session/${session.id}/shell`, { agent: "build", model, command: "true" })
          expect(shell.status).toBe(200)
          const inputs = yield* SessionInput.Service
          yield* inputs.admit(session.id, { requestID: "cancelled", delivery: "queue", text: "x" }).pipe(Effect.ignore)
          yield* inputs.cancel(session.id, "cancelled").pipe(Effect.ignore)
          expect((yield* info(dir, session.id)).time.turn).toBeUndefined()
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "an aborted turn and a failed turn both settle with an end at or after their start",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("never finishes").wait(held.promise).stop())
          const aborted = yield* Session.use.create({ title: "Aborted turn" })
          yield* post(dir, `/session/${aborted.id}/prompt_async`, { agent: "build", model, parts: [{ type: "text", text: "go" }] })
          yield* llm.wait(1)
          const running = (yield* info(dir, aborted.id)).time.turn!
          expect(running.started).toBeDefined()
          expect(running.ended).toBeUndefined()
          yield* post(dir, `/session/${aborted.id}/abort`)
          const stopped = (yield* settled(dir, aborted.id)).time.turn!
          expect(stopped.started).toBe(running.started)
          expect(stopped.ended!).toBeGreaterThanOrEqual(stopped.started!)

          yield* llm.error(500, { error: { message: "boom" } })
          const failed = yield* Session.use.create({ title: "Failed turn" })
          yield* post(dir, `/session/${failed.id}/prompt_async`, { agent: "build", model, parts: [{ type: "text", text: "go" }] })
          const turn = (yield* settled(dir, failed.id)).time.turn!
          expect(turn.ended!).toBeGreaterThanOrEqual(turn.started!)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "retry, deliver and nudge each start a new turn later than the previous one",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("retried")
          yield* llm.text("delivered")
          yield* llm.text("nudged")
          const session = yield* Session.use.create({ title: "Paths" })
          const failedStep = yield* seedFinished(session, {
            error: new SessionV1.APIError({ message: "x", statusCode: 403, isRetryable: false }).toObject(),
          })
          const retry = yield* post(dir, `/session/${session.id}/retry`, { messageID: failedStep.id })
          expect(Schema.decodeUnknownSync(SessionFailure.RetryResult)(yield* retry.json).outcome).toBe("accepted")
          const first = (yield* settled(dir, session.id)).time.turn!

          // A steer left pending (admitted without a wake) delivered on an idle session.
          const inputs = yield* SessionInput.Service
          yield* inputs.admit(session.id, { requestID: "steer-1", delivery: "steer", text: "also this" })
          expect(yield* (yield* post(dir, `/session/${session.id}/input/steer-1/deliver`)).json).toMatchObject({ outcome: "delivered" })
          const second = yield* pollWithTimeout(
            settled(dir, session.id).pipe(Effect.map((s) => (s.time.turn!.started! > first.started! ? s.time.turn! : undefined))),
            "deliver did not start a new turn",
            "45 seconds",
          )
          expect(second.started!).toBeGreaterThan(first.ended!)

          const messages = (yield* requestInDirectory(`/session/${session.id}/message`, dir).pipe(Effect.flatMap((r) => r.json))) as { info: { id: string } }[]
          const nudge = yield* post(dir, `/session/${session.id}/nudge`, { requestID: "turn-nudge", observedMessageID: messages.at(-1)!.info.id })
          expect(yield* nudge.json).toMatchObject({ outcome: "started" })
          const third = yield* pollWithTimeout(
            settled(dir, session.id).pipe(Effect.map((s) => (s.time.turn!.started! > second.started! ? s.time.turn! : undefined))),
            "nudge did not start a new turn",
            "45 seconds",
          )
          expect(third.started!).toBeGreaterThan(second.ended!)
          expect(yield* llm.inputs).toHaveLength(3)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.instance("turn boundaries keep time.updated and an old or repeated end never settles a newer start", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Boundaries" })
    const updated = (yield* sessions.get(session.id)).time.updated

    const first = yield* sessions.turnStarted(session.id)
    yield* sessions.turnEnded(session.id, first)
    const firstEnded = (yield* sessions.get(session.id)).time.turn!.ended!
    // Adjacent runs inside one millisecond: the next start still sorts after the previous end.
    const second = yield* sessions.turnStarted(session.id)
    expect(second).toBeGreaterThan(firstEnded)
    expect((yield* sessions.get(session.id)).time.turn).toEqual({ started: second })

    // A late end for the earlier start leaves the running turn open.
    yield* sessions.turnEnded(session.id, first)
    expect((yield* sessions.get(session.id)).time.turn).toEqual({ started: second })

    yield* sessions.turnEnded(session.id, second)
    const settledTurn = (yield* sessions.get(session.id)).time.turn!
    yield* Effect.sleep("5 millis")
    // A repeated end keeps the first end.
    yield* sessions.turnEnded(session.id, second)
    expect((yield* sessions.get(session.id)).time.turn).toEqual(settledTurn)
    expect((yield* sessions.get(session.id)).time.updated).toBe(updated)
  }),
)

it.live(
  "a start with no end, as a crash leaves it, reloads as an open turn with no end",
  () =>
    provideTmpdirServer(
      ({ dir }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "Cut off" })
          const started = yield* sessions.turnStarted(session.id)
          yield* Effect.promise(() => disposeAllInstances())
          expect((yield* info(dir, session.id)).time.turn).toEqual({ started })
          const status = (yield* requestInDirectory("/session/status", dir).pipe(Effect.flatMap((r) => r.json))) as Record<string, unknown>
          expect(status[session.id]).toBeUndefined()
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

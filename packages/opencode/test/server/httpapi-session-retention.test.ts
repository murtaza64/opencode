import { afterEach, expect } from "bun:test"
import { Clock, Duration, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionFailure } from "@/session/failure"
import { SessionRetention } from "@/session/retention"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { disposeAllInstances, provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(SessionRetention.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const WEEK = Duration.toMillis(SessionRetention.IDLE)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const prompt = { agent: "build", model: { providerID: "test", modelID: "test-model" } }

const frozen = (now: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.succeed(now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
  sleep: () => Effect.void,
})

const sweepAt = (now: number) =>
  SessionRetention.Service.use((retention) => retention.sweep()).pipe(Effect.provideService(Clock.Clock, frozen(now)))

const send = (dir: string, path: string, method: string, body: unknown) =>
  requestInDirectory(path, dir, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const listed = (dir: string, query: string) =>
  requestInDirectory(`/experimental/session?${query}`, dir).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as { id: string; time: { created: number; updated: number; archived?: number } }[]),
  )

const failureOf = (dir: string, sessionID: string) =>
  pollWithTimeout(
    requestInDirectory("/experimental/session/failed", dir).pipe(
      Effect.flatMap((response) => response.json),
      Effect.map((body) => Schema.decodeUnknownSync(Schema.Array(SessionFailure.Info))(body).find((item) => item.sessionID === sessionID)),
    ),
    "session did not become failed",
    "45 seconds",
  )

const retry = (dir: string, sessionID: string, messageID: string) =>
  send(dir, `/session/${sessionID}/retry`, "POST", { messageID }).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => Schema.decodeUnknownSync(SessionFailure.RetryResult)(body)),
  )

const archivedAt = (sessionID: Session.Info["id"]) =>
  Session.Service.use((sessions) => sessions.get(sessionID)).pipe(Effect.map((info) => info.time.archived))

it.live("an idle-archived session moves to the archived listing and is restored over the API with history intact", () =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Idle for a week" })
      const user: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        agent: "build",
        time: { created: session.time.updated },
        model,
      }
      yield* sessions.updateMessage(user)
      yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "hi" })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "assistant",
        parentID: user.id,
        agent: "build",
        mode: "build",
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: session.time.updated, completed: session.time.updated },
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      })
      const now = session.time.updated + WEEK

      expect(yield* sweepAt(now)).toContain(session.id)
      expect((yield* listed(dir, "roots=true&archived=true")).find((item) => item.id === session.id)?.time).toEqual({
        created: session.time.created,
        updated: session.time.updated,
        archived: now,
      })
      expect((yield* listed(dir, "roots=true")).some((item) => item.id === session.id)).toBe(false)

      const restore = yield* send(dir, `/session/${session.id}`, "PATCH", { time: { archived: null } })
      expect(restore.status).toBe(200)
      const restored = (yield* restore.json) as { time: { updated: number; archived?: number } }
      expect(restored.time.archived).toBeUndefined()
      expect(restored.time.updated).toBeGreaterThan(session.time.updated)
      expect((yield* listed(dir, "roots=true")).some((item) => item.id === session.id)).toBe(true)
      const history = yield* requestInDirectory(`/session/${session.id}/message`, dir).pipe(Effect.flatMap((r) => r.json))
      expect((history as unknown[]).length).toBe(2)
      expect(yield* sweepAt(now)).not.toContain(session.id)
    }),
  ),
)

it.live(
  "a settled failed session ages out, and a starting Retry and the archive never both win",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const later = Date.now() + 2 * WEEK
          // Held replies keep each accepted retry running until released.
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))

          // Running retry first: the archive must wait for it.
          yield* llm.error(403, { error: { message: "denied" } })
          yield* llm.push(reply().text("retried").wait(held.promise).stop())
          const running = yield* Session.use.create({ title: "Retry running" })
          yield* send(dir, `/session/${running.id}/prompt_async`, "POST", { ...prompt, parts: [{ type: "text", text: "go" }] })
          const runningFailure = yield* failureOf(dir, running.id)
          expect(yield* retry(dir, running.id, runningFailure.messageID)).toEqual({ outcome: "accepted" })
          expect(yield* sweepAt(later)).not.toContain(running.id)
          expect(yield* archivedAt(running.id)).toBeUndefined()

          // Archive first: the retry must refuse rather than run hidden work.
          yield* llm.error(403, { error: { message: "denied" } })
          const archivedFirst = yield* Session.use.create({ title: "Archived first" })
          yield* send(dir, `/session/${archivedFirst.id}/prompt_async`, "POST", { ...prompt, parts: [{ type: "text", text: "go" }] })
          const archivedFailure = yield* failureOf(dir, archivedFirst.id)
          const callsBefore = (yield* llm.inputs).length
          expect(yield* sweepAt(later)).toContain(archivedFirst.id)
          expect(yield* retry(dir, archivedFirst.id, archivedFailure.messageID)).toEqual({ outcome: "archived" })
          expect((yield* llm.inputs).length).toBe(callsBefore)

          // Concurrent: whichever wins, a retry that started is never archived.
          // Staggered sweep starts land at different points of the retry request and its guard.
          const raced = yield* Effect.forEach([0, 2, 5, 10, 20, 40], (delay, index) =>
            Effect.gen(function* () {
              yield* llm.error(403, { error: { message: "denied" } })
              yield* llm.push(reply().text(`raced ${index}`).wait(held.promise).stop())
              const session = yield* Session.use.create({ title: `Race ${index}` })
              yield* send(dir, `/session/${session.id}/prompt_async`, "POST", { ...prompt, parts: [{ type: "text", text: "go" }] })
              const failure = yield* failureOf(dir, session.id)
              const [outcome] = yield* Effect.all([retry(dir, session.id, failure.messageID), sweepAt(later).pipe(Effect.delay(delay))], {
                concurrency: "unbounded",
              })
              const archived = (yield* archivedAt(session.id)) !== undefined
              // A refused retry leaves its held reply queued; drop it before the next session's prompt.
              if (archived) yield* llm.reset
              return { outcome: outcome.outcome, archived }
            }),
          )
          for (const item of raced) expect(item).toEqual(item.archived ? { outcome: "archived", archived: true } : { outcome: "accepted", archived: false })

          held.resolve()
        }),
      { config: testProviderConfig },
    ),
  120_000,
)

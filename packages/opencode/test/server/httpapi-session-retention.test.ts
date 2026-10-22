import { afterEach, expect } from "bun:test"
import { Clock, Duration, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionRetention } from "@/session/retention"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(SessionRetention.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const listed = (dir: string, query: string) =>
  requestInDirectory(`/experimental/session?${query}`, dir).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as { id: string; time: { created: number; updated: number; archived?: number } }[]),
  )

it.live("an idle-archived session moves to the archived listing the app reads, with its history intact", () =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const retention = yield* SessionRetention.Service
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
      const now = session.time.updated + Duration.toMillis(SessionRetention.IDLE)

      expect(yield* retention.sweep().pipe(Effect.provideService(Clock.Clock, frozen(now)))).toContain(session.id)

      const all = yield* listed(dir, "roots=true&archived=true")
      expect(all.find((item) => item.id === session.id)?.time).toEqual({
        created: session.time.created,
        updated: session.time.updated,
        archived: now,
      })
      expect((yield* listed(dir, "roots=true")).some((item) => item.id === session.id)).toBe(false)
      const history = yield* requestInDirectory(`/session/${session.id}/message`, dir).pipe(
        Effect.flatMap((response) => response.json),
      )
      expect((history as unknown[]).length).toBe(2)
    }),
  ),
)

function frozen(now: number): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.succeed(now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
    sleep: () => Effect.void,
  }
}

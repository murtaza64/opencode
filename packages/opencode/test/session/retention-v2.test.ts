import { expect } from "bun:test"
import { Clock, Duration, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { node } from "@opencode-ai/core/session/runner/llm"
import { Session } from "@/session/session"
import { SessionRetention } from "@/session/retention"
import { SessionRunState } from "@/session/run-state"
import { SessionSupersession } from "@/session/supersession"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const started = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const provider = Layer.succeed(
  SessionRunner.Service,
  SessionRunner.Service.of({
    run: () => Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.promise(() => release.promise))),
  }),
)

const it = testEffect(
  AppNodeBuilderV1.build(
    LayerNode.group([
      Session.node,
      SessionRunState.node,
      SessionSupersession.node,
      SessionExecutionLocal.node,
      SessionV2.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      SessionRetention.node,
    ]),
    [
      [node, provider],
      [SessionExecution.node, SessionExecutionLocal.node],
    ],
  ),
)

const frozen = (now: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.succeed(now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
  sleep: () => Effect.void,
})

it.live(
  "an active V2 drain blocks archive until it settles",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
          const sessions = yield* Session.Service
          const execution = yield* SessionExecution.Service
          const retention = yield* SessionRetention.Service
          const session = yield* sessions.create({ title: "V2 drain" })
          const later = session.time.updated + 2 * Duration.toMillis(SessionRetention.IDLE)
          const sweep = retention.sweep().pipe(Effect.provideService(Clock.Clock, frozen(later)))

          yield* execution.wake(session.id)
          yield* Effect.promise(() => started.promise).pipe(Effect.timeout("20 seconds"))
          expect(SessionExecutionLocal.isActive(session.id)).toBe(true)

          expect(yield* retention.inspect(session.id, later)).toMatchObject({ blocker: "running" })
          expect(yield* retention.archive(session.id, later)).toBe(false)
          expect(yield* sweep).not.toContain(session.id)

          release.resolve()
          yield* pollWithTimeout(
            Effect.sync(() => (SessionExecutionLocal.isActive(session.id) ? undefined : true)),
            "V2 drain did not settle",
            "10 seconds",
          )
          expect(yield* sweep).toContain(session.id)
        }),
      { git: true },
    ),
  60_000,
)

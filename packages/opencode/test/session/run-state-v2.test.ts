import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { node } from "@opencode-ai/core/session/runner/llm"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionSupersession } from "@/session/supersession"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const started = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
let calls = 0
const provider = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({
  run: () => Effect.sync(() => {
    calls++
    started.resolve()
  }).pipe(Effect.andThen(Effect.promise(() => release.promise))),
}))

const it = testEffect(AppNodeBuilderV1.build(
  LayerNode.group([Session.node, SessionRunState.node, SessionSupersession.node, SessionExecutionLocal.node, SessionV2.node, SessionProjector.node, CrossSpawnSpawner.node]),
  [[node, provider], [SessionExecution.node, SessionExecutionLocal.node]],
))

it.live("a V2 drain holds the V1 pending fence until provider completion", () =>
  provideTmpdirInstance(() => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
    const sessions = yield* Session.Service
    const original = yield* sessions.create({ title: "Predecessor" })
    const successor = yield* sessions.create({ title: "Successor" })
    const execution = yield* SessionExecution.Service
    const run = yield* SessionRunState.Service
    const supersession = yield* SessionSupersession.Service
    yield* execution.wake(original.id)
    yield* execution.wake(original.id)
    yield* pollWithTimeout(Effect.sync(() => SessionExecutionLocal.isActive(original.id) ? true : undefined), "V2 execution never registered", "3 seconds")
    yield* Effect.promise(() => started.promise).pipe(Effect.timeout("20 seconds"))
    expect(calls).toBe(1)
    expect(SessionExecutionLocal.isActive(original.id)).toBe(true)
    expect((yield* run.supersede(original.id, successor.id)).state).toBe("pending")
    expect((yield* run.supersede(original.id, successor.id)).state).toBe("pending")
    expect((yield* Effect.flip(run.admit(original.id, Effect.die("V1 work admitted")))).state).toBe("pending")
    expect(yield* Effect.flip((yield* SessionV2.Service).prompt({ sessionID: original.id, prompt: Prompt.make({ text: "V2 work blocked" }) }))).toMatchObject({ state: "pending" })
    expect(yield* Effect.flip(execution.resume(original.id))).toMatchObject({ state: "pending" })
    expect((yield* supersession.get(original.id))?.state).toBe("pending")
    release.resolve()
    yield* pollWithTimeout(Effect.sync(() => SessionExecutionLocal.isActive(original.id) ? undefined : true), "V2 provider did not settle", "10 seconds")
    expect(calls).toBe(1)
    // The V2 drain settlement commits the fence itself; no V1 idle path or retry is needed.
    expect((yield* supersession.get(original.id))?.state).toBe("committed")
    expect((yield* run.supersede(original.id, successor.id)).state).toBe("committed")
    expect(yield* Effect.flip(execution.resume(original.id))).toMatchObject({ state: "committed" })
  }), { git: true }), 60_000)

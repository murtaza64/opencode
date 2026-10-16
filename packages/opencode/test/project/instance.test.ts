import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { GlobalBus } from "../../src/bus/global"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { InstanceRef } from "../../src/effect/instance-ref"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, SessionStatus.node, Permission.node, Question.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(disposer)),
    (off) => Effect.sync(off),
  )

describe("InstanceStore", () => {
  it.live("peek does not bootstrap unknown directories and returns the cached context after load", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let boots = 0
      yield* setBootstrap(Effect.sync(() => { boots++ }))
      expect(yield* store.peek(dir)).toBeUndefined()
      expect(store.size()).toBe(0)
      expect(boots).toBe(0)
      const ctx = yield* store.load({ directory: dir })
      expect(yield* store.peek(dir)).toBe(ctx)
      expect(store.size()).toBe(1)
      expect(boots).toBe(1)
    }),
  )

  it.effect("resolve memoizes project identity until the idle TTL without bootstrapping", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let boots = 0
      yield* setBootstrap(Effect.sync(() => { boots++ }))
      let updates = 0
      const onEvent = (event: { payload: { type: string } }) => {
        if (event.payload.type === "project.updated") updates++
      }
      GlobalBus.on("event", onEvent)
      yield* Effect.addFinalizer(() => Effect.sync(() => { GlobalBus.off("event", onEvent) }))
      const first = yield* store.resolve(dir)
      expect(yield* store.resolve(dir)).toBe(first)
      expect(updates).toBe(1)
      yield* TestClock.adjust("11 minutes")
      const next = yield* store.resolve(dir)
      expect(next).not.toBe(first)
      expect(next.project.id).toBe(first.project.id)
      expect(updates).toBe(2)
      expect(boots).toBe(0)
      expect(store.size()).toBe(0)
    }),
  )

  it.effect("sweeps idle instances and emits disposal without evicting cwd", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const events: string[] = []
      const onEvent = (event: { payload: { type: string }; directory?: string }) => {
        if (event.payload.type === "server.instance.disposed" && event.directory) events.push(event.directory)
      }
      GlobalBus.on("event", onEvent)
      yield* Effect.addFinalizer(() => Effect.sync(() => { GlobalBus.off("event", onEvent) }))
      yield* store.load({ directory: dir })
      yield* store.load({ directory: process.cwd() })
      yield* TestClock.adjust("11 minutes")
      expect(yield* store.peek(dir)).toBeUndefined()
      expect(yield* store.peek(process.cwd())).toBeDefined()
      expect(events).toContain(dir)
    }),
  )

  it.effect("keeps a busy instance during a sweep", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const status = yield* SessionStatus.Service
      const ctx = yield* store.load({ directory: dir })
      yield* status.set(SessionID.descending(), { type: "busy" }).pipe(Effect.provideService(InstanceRef, ctx))
      yield* TestClock.adjust("11 minutes")
      expect(yield* store.peek(dir)).toBe(ctx)
    }),
  )

  it.effect("keeps an instance with a pending permission during a sweep", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const permission = yield* Permission.Service
      const ctx = yield* store.load({ directory: dir })
      const ask = yield* permission.ask({ sessionID: SessionID.descending(), permission: "read", patterns: ["*"], always: [], metadata: {}, ruleset: [] }).pipe(
        Effect.provideService(InstanceRef, ctx), Effect.forkScoped,
      )
      yield* Effect.yieldNow
      expect((yield* permission.list().pipe(Effect.provideService(InstanceRef, ctx))).length).toBe(1)
      yield* TestClock.adjust("11 minutes")
      expect(yield* store.peek(dir)).toBe(ctx)
      yield* Fiber.interrupt(ask)
    }),
  )

  it.effect("keeps an instance with a pending question during a sweep", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const question = yield* Question.Service
      const ctx = yield* store.load({ directory: dir })
      const ask = yield* question.ask({ sessionID: SessionID.descending(), questions: [] }).pipe(
        Effect.provideService(InstanceRef, ctx), Effect.forkScoped,
      )
      yield* Effect.yieldNow
      expect((yield* question.list().pipe(Effect.provideService(InstanceRef, ctx))).length).toBe(1)
      yield* TestClock.adjust("11 minutes")
      expect(yield* store.peek(dir)).toBe(ctx)
      yield* Fiber.interrupt(ask)
    }),
  )

  it.effect("does not sweep an unfinished bootstrap", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* setBootstrap(Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }))
      const loading = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* TestClock.adjust("11 minutes")
      expect(yield* store.peek(dir)).toBeUndefined()
      expect(store.size()).toBe(1)
      yield* Deferred.succeed(release, undefined)
      const ctx = yield* Fiber.join(loading)
      expect(yield* store.peek(dir)).toBe(ctx)
    }),
  )

  it.effect("start returns the identity while bootstrap is still running and load joins the same boot", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let boots = 0
      yield* setBootstrap(Effect.gen(function* () {
        boots++
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }))
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const ctx = yield* store.start({ directory: dir })
      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
      yield* Deferred.await(started)
      expect(yield* store.peek(dir)).toBeUndefined()
      expect(store.size()).toBe(1)
      const loading = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(loading.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(loading)).toBe(ctx)
      expect(yield* store.peek(dir)).toBe(ctx)
      expect(boots).toBe(1)
    }),
  )

  it.effect("start on a ready instance returns the cached context without rebooting", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let boots = 0
      yield* setBootstrap(Effect.sync(() => { boots++ }))
      const ctx = yield* store.load({ directory: dir })
      expect(yield* store.start({ directory: dir })).toBe(ctx)
      expect(boots).toBe(1)
    }),
  )

  it.effect("a failed bootstrap after start fails load and clears the entry", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const release = yield* Deferred.make<void>()
      yield* setBootstrap(Effect.gen(function* () {
        yield* Deferred.await(release)
        return yield* Effect.die(new Error("bootstrap exploded"))
      }))
      const ctx = yield* store.start({ directory: dir })
      const loading = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(loading)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(store.size()).toBe(0)
      expect(ctx.directory).toBe(dir)
    }),
  )

  it.effect("a load refreshes lastUsed before the next sweep", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })
      yield* TestClock.adjust("9 minutes")
      expect(yield* store.load({ directory: dir })).toBe(ctx)
      yield* TestClock.adjust("2 minutes")
      expect(yield* store.peek(dir)).toBe(ctx)
    }),
  )

  it.effect("a concurrent load during a sweep retains the refreshed entry", () =>
    Effect.gen(function* () {
      const first = yield* tmpdirScoped({ git: true })
      const second = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* registerDisposerScoped(async (directory) => {
        if (directory !== first) return
        Deferred.doneUnsafe(disposing, Effect.void)
        await Effect.runPromise(Deferred.await(release))
      })
      yield* store.load({ directory: first })
      const ctx = yield* store.load({ directory: second })
      const advancing = yield* TestClock.adjust("11 minutes").pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      expect(yield* store.load({ directory: second })).toBe(ctx)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(advancing)
      expect(yield* store.peek(second)).toBe(ctx)
    }),
  )
  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("a cancelled waiter leaves shared bootstrap running without blocking another directory", () =>
    Effect.gen(function* () {
      const cold = yield* tmpdirScoped({ git: true })
      const warm = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let boots = 0
      yield* setBootstrap(
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (ctx?.directory !== cold) return
          boots++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: cold }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      // Release before store finalization even if an assertion fails.
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* Fiber.interrupt(first)
      const other = yield* store.load({ directory: warm })
      expect(other.directory).toBe(warm)
      const retry = yield* store.load({ directory: cold }).pipe(Effect.forkScoped)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(retry)).directory).toBe(cold)
      expect(boots).toBe(1)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )
})

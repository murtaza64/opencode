import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Exit, Scope, Fiber } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("interrupting the cancellation caller still completes cleanup", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const cleaned = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        id: "cancel-caller",
        type: "task",
        run: Effect.never,
        onCancel: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Deferred.succeed(cleaned, undefined)),
        ),
      })
      const cancel = yield* jobs.cancel(job.id).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const interrupt = yield* Fiber.interrupt(cancel).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupt)
      expect(yield* Deferred.isDone(cleaned)).toBe(true)
      const resumed = yield* jobs.start({ id: job.id, type: "task", run: Effect.succeed("done") })
      expect(resumed.run_id).not.toBe(job.run_id)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("cannot resume a child while its previous cancellation is still cleaning up", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const cancelling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const original = yield* jobs.start({
        id: "child-cleanup",
        type: "task",
        run: Effect.never,
        onCancel: Deferred.succeed(cancelling, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })
      const cancel = yield* jobs.cancel(original.id).pipe(Effect.forkChild)
      yield* Deferred.await(cancelling)
      const attempt = yield* jobs
        .start({ id: original.id, type: "task", run: Effect.die("must not dispatch") })
        .pipe(Effect.exit)
      expect(Exit.isFailure(attempt)).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(cancel)
      const resumed = yield* jobs.start({ id: original.id, type: "task", run: Effect.succeed("resumed") })
      expect(resumed.run_id).not.toBe(original.run_id)
      expect((yield* jobs.wait({ id: original.id })).info?.output).toBe("resumed")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("settles each generation once and preserves correlation across ID reuse", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const notice = yield* Deferred.make<BackgroundJob.Info>()
      const secondNotice = yield* Deferred.make<BackgroundJob.Info>()
      const notices: string[] = []
      yield* jobs.start({
        id: "same-child",
        type: "task",
        metadata: { generation: 1 },
        run: Deferred.await(first).pipe(Effect.as("first")),
        onSettled: (info) =>
          Effect.sync(() => notices.push(info.output ?? "")).pipe(
            Effect.andThen(Deferred.succeed(notice, info)),
            Effect.asVoid,
          ),
      })
      yield* jobs.start({ id: "same-child", type: "task", run: Effect.die("duplicate dispatched") })
      yield* jobs.extend({ id: "same-child", run: Effect.succeed("extended") })
      yield* Deferred.succeed(first, undefined)
      expect((yield* Deferred.await(notice)).metadata?.generation).toBe(1)
      yield* jobs.cancel("same-child")
      yield* jobs.start({
        id: "same-child",
        type: "task",
        metadata: { generation: 2 },
        run: Effect.succeed("resumed"),
        onSettled: (info) => Deferred.succeed(secondNotice, info).pipe(Effect.asVoid),
      })
      expect(yield* Deferred.await(secondNotice)).toMatchObject({ output: "resumed", metadata: { generation: 2 } })
      expect(notices).toEqual(["extended"])
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a fresh registry cannot infer completion or replay interrupted work", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      yield* jobs.start({
        id: "lost-child",
        type: "task",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })
      yield* Scope.close(scope, Exit.void)
      yield* Deferred.await(interrupted)
      const fresh = yield* BackgroundJob.make
      expect(yield* fresh.get("lost-child")).toBeUndefined()
      expect(yield* fresh.list()).toEqual([])
    }),
  )

  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})

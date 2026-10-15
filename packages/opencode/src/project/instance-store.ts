import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionStatus } from "@/session/status"
import { Clock, Context, Deferred, Duration, Effect, Exit, Layer, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly peek: (directory: string) => Effect.Effect<InstanceContext | undefined>
  readonly resolve: (directory: string) => Effect.Effect<InstanceContext>
  readonly size: () => number
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
  lastUsed: number
}

const layer: Layer.Layer<
  Service,
  never,
  | Project.Service
  | InstanceBootstrap.Service
  | SessionStatus.Service
  | Permission.Service
  | Question.Service
  | SessionExecution.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const status = yield* SessionStatus.Service
    const permission = yield* Permission.Service
    const question = yield* Question.Service
    const execution = yield* SessionExecution.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()
    const identities = new Map<string, { ctx: InstanceContext; resolved: number }>()
    const interval = Number(Flag.OPENCODE_INSTANCE_SWEEP_MS ?? 60_000)
    const ttl = Number(Flag.OPENCODE_INSTANCE_IDLE_TTL_MS ?? 600_000)

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      yield* disposeContext(ctx)
      if (cache.get(directory) !== entry) return false
      cache.delete(directory)
      return true
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing) {
            const ctx = yield* restore(Deferred.await(existing.deferred))
            existing.lastUsed = yield* Clock.currentTimeMillis
            return ctx
          }

          const entry: Entry = {
            deferred: Deferred.makeUnsafe<InstanceContext>(),
            lastUsed: yield* Clock.currentTimeMillis,
          }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory: directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          const ctx = yield* restore(Deferred.await(entry.deferred))
          entry.lastUsed = yield* Clock.currentTimeMillis
          return ctx
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          identities.delete(directory)
          const entry: Entry = {
            deferred: Deferred.makeUnsafe<InstanceContext>(),
            lastUsed: yield* Clock.currentTimeMillis,
          }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory: directory })
            if (previous) {
              yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
              yield* Effect.promise(() => runDisposers(directory))
              yield* emitDisposed({ directory, project: input.project?.id })
            }
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          const ctx = yield* restore(Deferred.await(entry.deferred))
          entry.lastUsed = yield* Clock.currentTimeMillis
          return ctx
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    const peek = (input: string) =>
      Effect.gen(function* () {
        const entry = cache.get(FSUtil.resolve(input))
        if (!entry || !(yield* Deferred.isDone(entry.deferred))) return undefined
        const exit = yield* Effect.exit(Deferred.await(entry.deferred))
        return Exit.isSuccess(exit) ? exit.value : undefined
      })

    // Project identity without bootstrapping: DB-only routes (session listing)
    // need only the project id and directory, never plugins, LSP or MCP.
    // Memoized for the idle TTL: fromDirectory upserts the project and emits
    // project.updated, so resolving per request turned dashboard polling over
    // many idle lane directories into a continuous global event flood.
    const resolve = (input: string) =>
      Effect.gen(function* () {
        const cached = yield* peek(input)
        if (cached) return cached
        const directory = FSUtil.resolve(input)
        const now = yield* Clock.currentTimeMillis
        const known = identities.get(directory)
        if (known && now - known.resolved < ttl) return known.ctx
        const result = yield* project.fromDirectory(directory)
        const ctx = { directory, worktree: result.sandbox, project: result.project } satisfies InstanceContext
        identities.set(directory, { ctx, resolved: now })
        return ctx
      })

    const sweep = Effect.fn("InstanceStore.sweep")(function* () {
      const now = yield* Clock.currentTimeMillis
      for (const [directory, identity] of identities) if (now - identity.resolved >= ttl) identities.delete(directory)
      let evicted = 0
      for (const [directory, entry] of cache) {
        if (directory === FSUtil.resolve(process.cwd()) || now - entry.lastUsed < ttl) continue
        if (!(yield* Deferred.isDone(entry.deferred))) continue
        const exit = yield* Effect.exit(Deferred.await(entry.deferred))
        if (Exit.isFailure(exit) || (yield* execution.activeDirectory(directory))) continue
        const ctx = exit.value
        const safe = yield* Effect.gen(function* () {
          if ([...(yield* status.list()).values()].some((s) => s.type === "busy" || s.type === "retry")) return false
          if ((yield* permission.list()).length) return false
          if ((yield* question.list()).length) return false
          return true
        }).pipe(Effect.provideService(InstanceRef, ctx))
        if (!safe || (yield* execution.activeDirectory(directory)) || now - entry.lastUsed < ttl || cache.get(directory) !== entry)
          continue
        yield* Effect.logInfo("evicting idle instance", { directory, idleMs: now - entry.lastUsed })
        if (yield* disposeEntry(directory, entry, ctx)) evicted++
      }
      return evicted
    })

    if (Number.isFinite(interval) && interval > 0 && Number.isFinite(ttl) && ttl >= 0) {
      yield* Effect.gen(function* () {
        let count = 0
        while (true) {
          yield* Effect.sleep(Duration.millis(interval))
          const evicted = yield* sweep().pipe(
            Effect.catchCause((cause) => Effect.logWarning("instance sweep failed", { cause }).pipe(Effect.as(0))),
          )
          count++
          if (evicted || count % 10 === 0) yield* Effect.logInfo("instance sweep", { instances: cache.size, evicted })
        }
      }).pipe(Effect.forkScoped)
    }

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      peek,
      resolve,
      size: () => cache.size,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)
export const executionNode = makeGlobalNode({ service: SessionExecution.Service, layer: SessionExecution.noopLayer, deps: [] })

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode, SessionStatus.node, Permission.node, Question.node, executionNode],
})

export * as InstanceStore from "./instance-store"

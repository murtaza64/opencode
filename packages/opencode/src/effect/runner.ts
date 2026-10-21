import { Cause, Clock, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>, admission?: boolean) => Effect.Effect<A, E>
  readonly consume: Effect.Effect<void>
  readonly wake: (work: Effect.Effect<A, E>) => Effect.Effect<WakeDecision, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly startIdle: <B, F, R>(
    work: Effect.Effect<A, E>,
    guard: Effect.Effect<B | undefined, F, R>,
  ) => Effect.Effect<StartDecision<B>, E | F, R>
  readonly cancel: Effect.Effect<void>
  readonly locked: <B, F, R>(work: (idle: boolean) => Effect.Effect<B, F, R>) => Effect.Effect<B, F, R>
}

export type WakeDecision =
  | { readonly outcome: "scheduled" | "coalesced"; readonly observedAt: number }
  | { readonly outcome: "ignored" }

export type StartDecision<B> =
  | { readonly outcome: "started" }
  | { readonly outcome: "busy" }
  | { readonly outcome: "rejected"; readonly reason: B }

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Stopping"; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
    canContinue?: (result: A) => boolean
    onAdmission?: (idle: boolean) => Effect.Effect<void, E>
    onSettled?: Effect.Effect<boolean>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0
  let pending: Effect.Effect<A, E> | undefined
  let unconsumed: Effect.Effect<A, E> | undefined

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const finishRun = (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    exit: Exit.Exit<A, E>,
  ): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Running" || st.run.id !== id) return [complete(done, exit), st] as const
        const fenced = yield* opts?.onSettled ?? Effect.succeed(false)
        if (fenced) {
          pending = undefined
          unconsumed = undefined
          yield* idle
          return [complete(done, exit), { _tag: "Idle" }] as const
        }
        const admission = unconsumed
        unconsumed = undefined
        // A new prompt must be observed before successful completion can release its waiters.
        if (admission && Exit.isSuccess(exit) && (opts?.canContinue?.(exit.value) ?? true)) {
          const run = yield* startRun(admission, done)
          return [Effect.void, { _tag: "Running", run }] as const
        }
        const work = pending
        pending = undefined
        if (work && Exit.isSuccess(exit)) {
          const followup = yield* Deferred.make<A, E | Cancelled>()
          const run = yield* startRun(work, followup)
          return [complete(done, exit), { _tag: "Running", run }] as const
        }
        yield* idle
        return [complete(done, exit), { _tag: "Idle" }] as const
      }),
    ).pipe(Effect.flatten)

  const startRun = (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
  ): Effect.Effect<RunHandle<A, E>> =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          yield* opts?.onSettled ?? Effect.succeed(false)
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          if (yield* opts?.onSettled ?? Effect.succeed(false)) {
            yield* Deferred.fail(st.run.done, new Cancelled())
            return [idle, { _tag: "Idle" }] as const
          }
          const run = yield* startRun(st.run.work, st.run.done)
          return [Effect.void, { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const ensureRunning = (work: Effect.Effect<A, E>, admission = false): Effect.Effect<A, E> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        yield* opts?.onAdmission?.(st._tag === "Idle") ?? Effect.void
        if (admission && st._tag !== "Stopping") unconsumed = work
        switch (st._tag) {
          case "Stopping":
            return [Deferred.await(st.done).pipe(Effect.andThen(() => ensureRunning(work, admission))), st] as const
          case "Running":
          case "ShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const wake = (work: Effect.Effect<A, E>): Effect.Effect<WakeDecision, E> =>
    SynchronizedRef.modifyEffect<State<A, E>, WakeDecision, E, never>(
      ref,
      Effect.fnUntraced(function* (st) {
        yield* opts?.onAdmission?.(st._tag === "Idle") ?? Effect.void
        if (st._tag === "Stopping") {
          return [{ outcome: "ignored" }, st] as const
        }
        if (st._tag === "Running" || st._tag === "ShellThenRun") {
          pending = work
          return [{ outcome: "coalesced", observedAt: yield* Clock.currentTimeMillis }, st] as const
        }
        const done = yield* Deferred.make<A, E | Cancelled>()
        if (st._tag === "Shell")
          return [
            { outcome: "coalesced", observedAt: yield* Clock.currentTimeMillis },
            { _tag: "ShellThenRun", shell: st.shell, run: { id: next(), done, work } },
          ] as const
        const run = yield* startRun(work, done)
        return [{ outcome: "scheduled", observedAt: yield* Clock.currentTimeMillis }, { _tag: "Running", run }] as const
      }),
    )

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        yield* opts?.onAdmission?.(st._tag === "Idle") ?? Effect.void
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  // The guard runs under the state lock, so its precondition still holds when the run starts.
  const startIdle = <B, F, R>(
    work: Effect.Effect<A, E>,
    guard: Effect.Effect<B | undefined, F, R>,
  ): Effect.Effect<StartDecision<B>, E | F, R> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        yield* opts?.onAdmission?.(st._tag === "Idle") ?? Effect.void
        if (st._tag !== "Idle") return [{ outcome: "busy" } as StartDecision<B>, st] as const
        const reason = yield* guard
        if (reason !== undefined) return [{ outcome: "rejected", reason } as StartDecision<B>, st] as const
        const run = yield* startRun(work, yield* Deferred.make<A, E | Cancelled>())
        return [{ outcome: "started" } as StartDecision<B>, { _tag: "Running", run }] as const
      }),
    )

  const cancel = SynchronizedRef.modifyEffect(
    ref,
    Effect.fnUntraced(function* (st) {
      pending = undefined
      unconsumed = undefined
      if (st._tag === "Idle") return [Effect.void, st] as const
      if (st._tag === "Stopping") return [Deferred.await(st.done), st] as const
      const done = yield* Deferred.make<void>()
      const stop = Effect.gen(function* () {
        if (st._tag === "Running") yield* Fiber.interrupt(st.run.fiber)
        else yield* stopShell(st.shell)
        if (st._tag === "Running" || st._tag === "ShellThenRun") yield* Deferred.fail(st.run.done, new Cancelled())
      }).pipe(
        Effect.ensuring(
          SynchronizedRef.updateEffect(
            ref,
            Effect.fnUntraced(function* (current) {
              if (current._tag !== "Stopping" || current.done !== done) return current
              yield* idle
              yield* Deferred.succeed(done, undefined)
              return { _tag: "Idle" } as const
            }),
          ),
        ),
      )
      return [stop, { _tag: "Stopping", done }] as const
    }),
  ).pipe(Effect.flatten, Effect.uninterruptible)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    // Called before reading the inputs that the current work will consume.
    consume: Effect.sync(() => {
      unconsumed = undefined
    }),
    wake,
    startShell,
    startIdle,
    cancel,
    locked: <B, F, R>(work: (idle: boolean) => Effect.Effect<B, F, R>) =>
      SynchronizedRef.modifyEffect(
        ref,
        Effect.fnUntraced(function* (st) {
          const result = yield* work(st._tag === "Idle")
          return [result, st] as const
        }),
      ),
  }
}

export * as Runner from "./runner"

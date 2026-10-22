import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionSupersession } from "./supersession"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly wake: (sessionID: SessionID, work: Effect.Effect<SessionV1.WithParts | undefined>) => Effect.Effect<Runner.WakeDecision, SessionSupersession.Closed>
  readonly admit: <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SessionSupersession.Closed, R>
  readonly supersede: (
    sessionID: SessionID,
    successor: SessionID,
    scope?: SessionSupersession.Scope,
  ) => Effect.Effect<SessionSupersession.Receipt, SessionSupersession.Invalid | SessionSupersession.Closed>
  readonly cancelSupersession: (sessionID: SessionID) => Effect.Effect<SessionSupersession.Receipt | undefined, SessionSupersession.Closed>
  readonly consume: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    admission?: boolean,
  ) => Effect.Effect<SessionV1.WithParts, SessionSupersession.Closed>
  readonly startIdle: <B, F, R>(
    sessionID: SessionID,
    work: Effect.Effect<SessionV1.WithParts>,
    guard: Effect.Effect<B | undefined, F, R>,
  ) => Effect.Effect<Runner.StartDecision<B>, F | SessionSupersession.Closed, R>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError | SessionSupersession.Closed>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}
const noAdvisoryWork = Symbol("noAdvisoryWork")

export const completedTurn = (
  user: Pick<SessionV1.User, "id"> | undefined,
  assistant: SessionV1.Assistant | undefined,
  parts: readonly SessionV1.Part[],
  allowInterruptedTools = false,
) => {
  if (!user || !assistant || assistant.parentID !== user.id || assistant.error) return false
  if (assistant.structured !== undefined) return true
  if (!assistant.finish || ["tool-calls", "unknown"].includes(assistant.finish)) return false
  // "stop" with tool calls still needs continuation, except legacy interrupted-orphan cleanup.
  return !parts.some(
    (part) =>
      part.type === "tool" &&
      !part.metadata?.providerExecuted &&
      !(allowInterruptedTools && part.state.status === "error" && part.state.metadata?.interrupted === true),
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const supersession = yield* SessionSupersession.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts | typeof noAdvisoryWork | undefined, SessionSupersession.Closed>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const gate = (sessionID: SessionID, idle: boolean) => Effect.gen(function* () {
      const current = yield* supersession.get(sessionID)
      if (!current) return
      if (idle && current.state === "pending" && !SessionExecutionLocal.isActive(sessionID)) {
        return yield* new SessionSupersession.Closed((yield* supersession.commit(sessionID)) ?? current)
      }
      return yield* new SessionSupersession.Closed(current)
    })

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts | undefined>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const settle = Effect.gen(function* () {
        if (!(yield* supersession.get(sessionID))) return false
        if (SessionExecutionLocal.isActive(sessionID)) return true
        yield* supersession.commit(sessionID)
        return true
      })
      const next = Runner.make<SessionV1.WithParts | typeof noAdvisoryWork | undefined, SessionSupersession.Closed>(data.scope, {
        // Retain the owner while callers may still hold it across cancellation cleanup.
        onIdle: Effect.andThen(settle, status.set(sessionID, { type: "idle" })),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
        onSettled: settle,
        onAdmission: (idle) => gate(sessionID, idle),
        canContinue: (result) =>
          result === noAdvisoryWork ||
          (result?.info.role === "assistant" && completedTurn({ id: result.info.parentID }, result.info, result.parts)),
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const admit = <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const owner = yield* runner(sessionID, Effect.succeed(undefined))
        return yield* owner.locked((idle) => Effect.andThen(gate(sessionID, idle), work))
      })

    const supersede = Effect.fn("SessionRunState.supersede")(function* (
      sessionID: SessionID,
      successor: SessionID,
      scope: SessionSupersession.Scope = "same-directory",
    ) {
      const owner = yield* runner(sessionID, Effect.succeed(undefined))
      return yield* owner.locked((idle) => Effect.gen(function* () {
        const receipt = yield* supersession.request(sessionID, successor, scope)
        if (idle && receipt.state === "pending" && !SessionExecutionLocal.isActive(sessionID))
          return (yield* supersession.commit(sessionID)) ?? receipt
        return receipt
      }))
    })

    const cancelSupersession = Effect.fn("SessionRunState.cancelSupersession")(function* (sessionID: SessionID) {
      // Serialized with supersede/admit so a cancel never interleaves with a fence request or an idle commit.
      const owner = yield* runner(sessionID, Effect.succeed(undefined))
      return yield* owner.locked(() => supersession.cancel(sessionID))
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      admission = false,
    ) {
      const owner = yield* runner(sessionID, onInterrupt)
      while (true) {
        const result = yield* owner.ensureRunning(work, admission)
        if (result === noAdvisoryWork) continue
        return result ?? (yield* onInterrupt)
      }
    })

    const wake = Effect.fn("SessionRunState.wake")(function* (
      sessionID: SessionID,
      work: Effect.Effect<SessionV1.WithParts | undefined>,
    ) {
      const owner = yield* runner(sessionID, Effect.succeed(undefined))
      return yield* owner.wake(work.pipe(Effect.map((result) => result ?? noAdvisoryWork)))
    })

    const startIdle = <B, F, R>(
      sessionID: SessionID,
      work: Effect.Effect<SessionV1.WithParts>,
      guard: Effect.Effect<B | undefined, F, R>,
    ) =>
      Effect.gen(function* () {
        const owner = yield* runner(sessionID, Effect.succeed(undefined))
        return yield* owner.startIdle(work, guard)
      })

    const consume = Effect.fn("SessionRunState.consume")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const owner = data.runners.get(sessionID)
      if (owner) yield* owner.consume
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      const owner = yield* runner(sessionID, onInterrupt)
      const result = yield* owner
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
      return result === noAdvisoryWork || result === undefined ? yield* onInterrupt : result
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell, startIdle, wake, consume, admit, supersede, cancelSupersession })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node, SessionSupersession.node] })

export * as SessionRunState from "./run-state"

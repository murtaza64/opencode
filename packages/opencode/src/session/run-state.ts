import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly wake: (sessionID: SessionID, work: Effect.Effect<SessionV1.WithParts | undefined>) => Effect.Effect<void>
  readonly consume: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    admission?: boolean,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
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

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts | typeof noAdvisoryWork | undefined>>()
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

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts | undefined>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts | typeof noAdvisoryWork | undefined>(data.scope, {
        // Retain the owner while callers may still hold it across cancellation cleanup.
        onIdle: status.set(sessionID, { type: "idle" }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
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
      yield* owner.wake(work.pipe(Effect.map((result) => result ?? noAdvisoryWork)))
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

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell, wake, consume })
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

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"

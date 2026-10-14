import { Cause, Effect, Layer, Option } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { Database } from "../../database/database"
import { SessionSupersession } from "../supersession"

const activeSessions = new Map<SessionSchema.ID, number>()

/** Current-process V2 drains, including queued wakes and provider cleanup. */
export const isActive = (sessionID: SessionSchema.ID): boolean => activeSessions.has(sessionID)

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      onActive: (sessionID) => activeSessions.set(sessionID, (activeSessions.get(sessionID) ?? 0) + 1),
      onIdle: (sessionID) => {
        const count = activeSessions.get(sessionID)
        if (count === 1) activeSessions.delete(sessionID)
        else if (count !== undefined) activeSessions.set(sessionID, count - 1)
      },
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        yield* SessionSupersession.assertOpen(db, sessionID)
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause) || Option.getOrUndefined(Cause.findErrorOption(cause)) instanceof SessionSupersession.Closed
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }, (drain, sessionID) =>
        // A fence requested while this drain ran waits for provider completion; it commits
        // here so a V2 predecessor does not depend on the V1 idle path to close.
        Effect.ensuring(drain, SessionSupersession.commitPending(db, sessionID)),
      ),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      activeDirectory: (directory) => Effect.gen(function* () {
        for (const sessionID of yield* coordinator.active) {
          const session = yield* store.get(sessionID)
          if (session?.location.directory === directory) return true
        }
        return false
      }),
      interrupt: coordinator.interrupt,
      resume: (sessionID) => SessionSupersession.assertOpen(db, sessionID).pipe(Effect.andThen(coordinator.run(sessionID))),
      wake: (sessionID) => SessionSupersession.assertOpen(db, sessionID).pipe(Effect.andThen(coordinator.wake(sessionID))),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, Database.node],
})

export * as SessionExecutionLocal from "./local"

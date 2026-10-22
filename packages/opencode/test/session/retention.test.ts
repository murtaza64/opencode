import { describe, expect } from "bun:test"
import { Clock, Duration, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionInput as SessionInputV2 } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSupersessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { GlobalBus } from "@/bus/global"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionRetention } from "@/session/retention"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import * as TestClock from "effect/testing/TestClock"
import { provideTmpdirInstance } from "../fixture/fixture"
import { it as base, pollWithTimeout, testEffect } from "../lib/effect"

const services = LayerNode.group([
  Database.node,
  EventV2.node,
  Session.node,
  EventV2Bridge.node,
  SessionProjector.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
  SessionRetention.node,
])
const replacements: LayerNode.Replacements = [
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
  [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
]
const it = testEffect(AppNodeBuilder.build(services, replacements))

const WEEK = Duration.toMillis(SessionRetention.IDLE)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

// A frozen wall clock for the code under test; sleeps still use the real clock.
const at =
  (now: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.clockWith((real) =>
      effect.pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillisUnsafe: () => now,
          currentTimeMillis: Effect.succeed(now),
          currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
          currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
          sleep: (duration) => real.sleep(duration),
        }),
      ),
    )

const sweepAt = (now: number) =>
  SessionRetention.Service.use((retention) => retention.sweep()).pipe(at(now))

const archivedAt = (sessionID: SessionID) => Session.Service.use((sessions) => sessions.get(sessionID)).pipe(Effect.map((info) => info.time.archived))

const userMessage = (sessionID: SessionID, created: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const user: SessionV1.User = { id: MessageID.ascending(), sessionID, role: "user", agent: "build", time: { created }, model }
    yield* sessions.updateMessage(user)
    yield* sessions.updatePart({ id: PartID.ascending(), sessionID, messageID: user.id, type: "text", text: "hello" })
    return user
  })

/** One durable exchange: a prompt and its reply, stamped at `created`. */
const exchange = (
  sessionID: SessionID,
  created: number,
  reply: { completed?: boolean; error?: SessionV1.Assistant["error"] } = {},
) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.get(sessionID)
    const user = yield* userMessage(sessionID, created)
    yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      parentID: user.id,
      agent: "build",
      mode: "build",
      modelID: model.modelID,
      providerID: model.providerID,
      time: { created, ...(reply.completed === false ? {} : { completed: created }) },
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(reply.error ? { error: reply.error } : reply.completed === false ? {} : { finish: "stop" }),
    } satisfies SessionV1.Assistant)
  })

/** A root Session whose newest durable activity is a finished exchange at a known time. */
const idleRoot = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  const activity = session.time.updated + 1_000
  yield* exchange(session.id, activity)
  return { session, activity }
})

describe("session retention threshold", () => {
  it.instance("archives a root exactly seven days after its newest durable activity", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { session, activity } = yield* idleRoot

      expect(yield* sweepAt(activity + WEEK - 1)).not.toContain(session.id)
      expect(yield* archivedAt(session.id)).toBeUndefined()

      expect(yield* sweepAt(activity + WEEK)).toContain(session.id)
      const archived = yield* sessions.get(session.id)
      expect(archived.time.archived).toBe(activity + WEEK)
      expect(archived.time.updated).toBe(session.time.updated)
      expect((yield* sessions.messages({ sessionID: session.id })).map((message) => message.info.role)).toEqual([
        "user",
        "assistant",
      ])
    }),
  )

  it.instance("counts session updates, not only messages, as activity", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      yield* exchange(session.id, session.time.updated - 3 * WEEK)
      yield* sessions.setTitle({ sessionID: session.id, title: "renamed" })
      const renamed = (yield* sessions.get(session.id)).time.updated

      expect(yield* sweepAt(renamed + WEEK - 1)).not.toContain(session.id)
      expect(yield* sweepAt(renamed + WEEK)).toContain(session.id)
    }),
  )

  it.instance("counts when a long step completed, not only when it started", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const started = session.time.updated + 1_000
      const user = yield* userMessage(session.id, started)
      const completed = started + 3 * WEEK
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "assistant",
        parentID: user.id,
        agent: "build",
        mode: "build",
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: started, completed },
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      } satisfies SessionV1.Assistant)

      expect(yield* sweepAt(completed + WEEK - 1)).not.toContain(session.id)
      expect(yield* sweepAt(completed + WEEK)).toContain(session.id)
    }),
  )

  it.instance("treats activity stamped after now as recent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      yield* exchange(session.id, session.time.updated + 30 * WEEK)

      expect(yield* sweepAt(session.time.updated + 2 * WEEK)).not.toContain(session.id)
    }),
  )

  it.instance("never archives child sessions on their own", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { session, activity } = yield* idleRoot
      const child = yield* sessions.create({ parentID: session.id })
      yield* exchange(child.id, activity)

      expect(yield* sweepAt(Math.max(activity, child.time.updated) + WEEK)).toContain(session.id)
      expect(yield* archivedAt(child.id)).toBeUndefined()
    }),
  )

  it.instance("keeps a root while a subagent child has newer activity", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { session, activity } = yield* idleRoot
      const child = yield* sessions.create({ parentID: session.id })
      const grandchild = yield* sessions.create({ parentID: child.id })
      yield* exchange(grandchild.id, activity + 3 * WEEK)

      expect(yield* sweepAt(activity + 2 * WEEK)).not.toContain(session.id)
      expect(yield* sweepAt(activity + 4 * WEEK)).toContain(session.id)
    }),
  )
})

describe("session retention gates", () => {
  it.instance("skips a root whose newest assistant step never completed", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const activity = session.time.updated + 1_000
      yield* exchange(session.id, activity, { completed: false })

      expect(yield* retention.inspect(session.id, activity + 2 * WEEK)).toEqual({
        type: "blocked",
        sessionID: session.id,
        blocker: "turn",
      })
      expect(yield* sweepAt(activity + 2 * WEEK)).not.toContain(session.id)
    }),
  )

  it.instance("skips a root whose newest step failed and awaits retry", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const activity = session.time.updated + 1_000
      yield* exchange(session.id, activity, {
        error: new SessionV1.AuthError({ providerID: "test", message: "expired" }).toObject(),
      })

      expect((yield* retention.inspect(session.id, activity + 2 * WEEK)).type).toBe("blocked")
    }),
  )

  it.instance("archives a root whose newest step was aborted by the user", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const activity = session.time.updated + 1_000
      yield* exchange(session.id, activity, {
        error: new SessionV1.AbortedError({ message: "aborted" }).toObject(),
      })

      expect(yield* sweepAt(activity + WEEK)).toContain(session.id)
    }),
  )

  it.instance("skips a root whose newest message is an unanswered prompt", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const activity = session.time.updated + 1_000
      yield* userMessage(session.id, activity)

      expect(yield* retention.inspect(session.id, activity + 2 * WEEK)).toMatchObject({ blocker: "turn" })
    }),
  )

  it.instance("skips a root while a child awaits a permission inside an unfinished step", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const sessions = yield* Session.Service
      const { session, activity } = yield* idleRoot
      const child = yield* sessions.create({ parentID: session.id })
      yield* exchange(child.id, activity, { completed: false })

      expect(yield* retention.inspect(session.id, child.time.updated + 2 * WEEK)).toEqual({
        type: "blocked",
        sessionID: child.id,
        blocker: "turn",
      })
    }),
  )

  it.instance("skips a busy or retrying root reported by this process", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const events = yield* EventV2.Service
      const { session, activity } = yield* idleRoot
      const later = activity + 2 * WEEK

      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: session.id,
        status: { type: "retry", attempt: 1, message: "rate limited", next: later },
      })
      yield* pollWithTimeout(
        retention.inspect(session.id, later).pipe(Effect.map((verdict) => (verdict.type === "blocked" ? verdict : undefined))),
        "retrying session was not observed",
      ).pipe(Effect.map((verdict) => expect(verdict.blocker).toBe("running")))
      expect(yield* sweepAt(later)).not.toContain(session.id)

      yield* events.publish(SessionStatusEvent.Status, { sessionID: session.id, status: { type: "idle" } })
      yield* pollWithTimeout(
        retention.inspect(session.id, later).pipe(Effect.map((verdict) => (verdict.type === "eligible" ? verdict : undefined))),
        "idle session was not observed",
      )
      expect(yield* sweepAt(later)).toContain(session.id)
    }),
  )

  it.instance("skips a root with pending V1 input until it is promoted or cancelled", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const events = yield* EventV2Bridge.Service
      const { session, activity } = yield* idleRoot
      yield* events.publish(SessionV1.Event.InputAdmitted, {
        sessionID: session.id,
        payload: { requestID: "req_pending", delivery: "queue", text: "queued for later" },
        agent: "build",
        model,
        time: activity,
      })

      expect(yield* retention.inspect(session.id, activity + 2 * WEEK)).toMatchObject({ blocker: "input" })

      yield* events.publish(SessionV1.Event.InputCancelled, { sessionID: session.id, requestID: "req_pending", time: activity })
      expect(yield* sweepAt(activity + 2 * WEEK)).toContain(session.id)
    }),
  )

  it.instance("skips a root with editspace mail that was promoted but never handled", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const events = yield* EventV2Bridge.Service
      const { session, activity } = yield* idleRoot
      yield* events.publish(SessionV1.Event.InputAdmitted, {
        sessionID: session.id,
        payload: {
          requestID: "req_mail",
          delivery: "steer",
          text: "mail",
          source: { type: "editspace-mail", id: "mail_1", sender: "orchestrator", recipient: "lane", kind: "task" },
        },
        agent: "build",
        model,
        time: activity,
      })
      const info: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        agent: "build",
        time: { created: activity - 1 },
        model,
      }
      yield* events.publish(SessionV1.Event.InputPromoted, {
        sessionID: session.id,
        requestID: "req_mail",
        info,
        part: { id: PartID.ascending(), sessionID: session.id, messageID: info.id, type: "text", text: "mail" },
      })

      expect(yield* retention.inspect(session.id, activity + 2 * WEEK)).toMatchObject({ blocker: "input" })
    }),
  )

  it.instance("skips V2 pending input and an unanswered promoted V2 prompt", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const { session, activity } = yield* idleRoot
      const admitted = yield* SessionInputV2.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: session.id,
        prompt: { text: "steer me" },
        delivery: "steer",
      })
      const later = admitted.timeCreated.epochMilliseconds + 2 * WEEK

      expect(yield* retention.inspect(session.id, later)).toMatchObject({ blocker: "input" })

      yield* SessionInputV2.promoteSteers(db, events, session.id, admitted.admittedSeq)
      expect(yield* retention.inspect(session.id, later)).toMatchObject({ blocker: "turn" })
      expect(yield* sweepAt(later)).not.toContain(session.id)
    }),
  )

  it.instance("skips a predecessor whose handoff is still pending", () =>
    Effect.gen(function* () {
      const retention = yield* SessionRetention.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const { session, activity } = yield* idleRoot
      const successor = yield* sessions.create({})
      yield* db
        .insert(SessionSupersessionTable)
        .values({ session_id: session.id, successor_id: successor.id, state: "pending" })
        .run()
        .pipe(Effect.orDie)

      expect(yield* retention.inspect(session.id, activity + 2 * WEEK)).toMatchObject({ blocker: "handoff" })

      yield* db
        .update(SessionSupersessionTable)
        .set({ state: "committed", time_committed: activity })
        .run()
        .pipe(Effect.orDie)
      expect(yield* sweepAt(Math.max(activity, successor.time.updated) + WEEK)).toContain(session.id)
    }),
  )
})

describe("session retention writes", () => {
  it.instance("is idempotent and leaves earlier manual archives untouched", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const auto = yield* idleRoot
      const manual = yield* idleRoot
      yield* sessions.setArchived({ sessionID: manual.session.id, time: manual.activity + 1 })
      const now = Math.max(auto.activity, manual.activity) + WEEK

      expect(yield* sweepAt(now)).toContain(auto.session.id)
      expect(yield* sweepAt(now + WEEK)).not.toContain(auto.session.id)
      expect(yield* archivedAt(auto.session.id)).toBe(now)
      expect(yield* archivedAt(manual.session.id)).toBe(manual.activity + 1)
    }),
  )

  it.instance("archives once when sweeps and a manual archive race", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { session, activity } = yield* idleRoot
      const now = activity + WEEK
      const results = yield* Effect.all(
        [
          sweepAt(now),
          sweepAt(now),
          sessions.setArchived({ sessionID: session.id, time: now + 5 }).pipe(Effect.as([] as SessionID[])),
          sweepAt(now),
        ],
        { concurrency: "unbounded" },
      )

      expect(results.flat().filter((id) => id === session.id).length).toBeLessThanOrEqual(1)
      expect([now, now + 5]).toContain((yield* archivedAt(session.id))!)
      expect(yield* sweepAt(now + WEEK)).not.toContain(session.id)
    }),
  )

  it.instance("counts downtime after a restart but still holds turns a dead process left unfinished", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventV2.Service
      const idle = yield* idleRoot
      const interrupted = yield* sessions.create({})
      yield* exchange(interrupted.id, idle.activity, { completed: false })
      yield* events.publish(SessionStatusEvent.Status, { sessionID: interrupted.id, status: { type: "busy" } })

      // A fresh process: new services over the same database, with no in-memory status.
      const restarted = yield* sweepAt(idle.activity + 3 * WEEK).pipe(
        Effect.provide(AppNodeBuilder.build(LayerNode.group([SessionRetention.node]))),
      )

      expect(restarted).toContain(idle.session.id)
      expect(restarted).not.toContain(interrupted.id)
      expect(yield* archivedAt(interrupted.id)).toBeUndefined()
    }),
  )

  it.instance("announces the archive on the global bus for the Session's directory", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { session, activity } = yield* idleRoot
      const seen: { directory?: string; archived?: number }[] = []
      const listener = (event: { directory?: string; payload: { type?: string; properties?: unknown } }) => {
        if (event.payload.type !== SessionV1.Event.Updated.type) return
        const data = event.payload.properties as { sessionID: string; info: { time: { archived?: number } } }
        if (data.sessionID === session.id) seen.push({ directory: event.directory, archived: data.info.time.archived })
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      yield* sweepAt(activity + WEEK)

      expect(seen).toEqual([{ directory: session.directory, archived: activity + WEEK }])
    }),
  )
})

describe("session retention schedule", () => {
  // The service graph starts on the test clock two weeks ahead, so roots made on the real clock are already due.
  // Starting it at time zero would make every periodic fiber replay decades of ticks once the clock jumps.
  base.effect("first sweeps after the startup delay, then hourly", () =>
    Effect.gen(function* () {
      const start = Date.now() + 2 * WEEK
      const delay = Duration.toMillis(SessionRetention.STARTUP_DELAY)
      const hour = Duration.toMillis(SessionRetention.INTERVAL)
      yield* TestClock.setTime(start)
      const scenario = Effect.gen(function* () {
        const archivedNow = (sessionID: SessionID) => TestClock.withLive(archivedAt(sessionID))
        const archived = (sessionID: SessionID) =>
          TestClock.withLive(pollWithTimeout(archivedAt(sessionID), "scheduled sweep did not archive the session"))
        const first = yield* TestClock.withLive(idleRoot)

        yield* TestClock.adjust(delay - 1)
        expect(yield* archivedNow(first.session.id)).toBeUndefined()
        yield* TestClock.adjust(1)
        expect(yield* archived(first.session.id)).toBe(start + delay)

        const second = yield* TestClock.withLive(idleRoot)
        yield* TestClock.adjust(hour - 1)
        expect(yield* archivedNow(second.session.id)).toBeUndefined()
        yield* TestClock.adjust(1)
        expect(yield* archived(second.session.id)).toBe(start + delay + hour)
      })
      yield* provideTmpdirInstance(() => scenario).pipe(Effect.provide(AppNodeBuilder.build(services, replacements)))
    }),
  )
})

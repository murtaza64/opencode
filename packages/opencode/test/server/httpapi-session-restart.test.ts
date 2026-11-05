import { afterEach, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionRestart } from "@/session/restart"
import { MessageID, PartID } from "@/session/schema"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const RESTART = "restart-1792624286253-72000"

const resume = (dir: string, sessionID: string, body: { restartID?: string; anchorMessageID: string; capturedAt: number }) =>
  requestInDirectory(`/session/${sessionID}/restart`, dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ restartID: RESTART, ...body }),
  }).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
    Effect.flatMap((response) => response.json),
    Effect.map((value) => Schema.decodeUnknownSync(SessionRestart.ContinueResult)(value)),
  )

const restartStatus = (dir: string, sessionID: string, anchorMessageID: string) =>
  requestInDirectory(`/session/${sessionID}/restart?restartID=${RESTART}&anchorMessageID=${anchorMessageID}`, dir).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
    Effect.flatMap((response) => response.json),
    Effect.map((value) => Schema.decodeUnknownSync(SessionRestart.Status)(value)),
  )

const messages = (dir: string, sessionID: string) =>
  requestInDirectory(`/session/${sessionID}/message`, dir).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
  )

const idleWithReply = (dir: string, sessionID: string, text: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = (yield* requestInDirectory("/session/status", dir).pipe(Effect.flatMap((r) => r.json))) as Record<string, { type: string }>
      if (status[sessionID] && status[sessionID].type !== "idle") return undefined
      const history = yield* messages(dir, sessionID)
      const last = history.at(-1)
      return last?.info.role === "assistant" && last.info.finish === "stop" &&
        last.parts.some((part) => part.type === "text" && part.text === text)
        ? history
        : undefined
    }),
    "restart continuation did not finish",
    "45 seconds",
  )

const toolRuns = (dir: string) => Effect.promise(() => Bun.file(path.join(dir, "tool-runs")).text().catch(() => ""))

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

// The rows a killed daemon leaves behind: a user prompt and an assistant step with no completion,
// one tool that finished (and counted its side effect) and one still pending.
const seedInterrupted = Effect.fn("test.seedInterrupted")(function* (
  session: Session.Info,
  dir: string,
  options: {
    tools?: "mixed" | "completed" | "cancelled" | false
    text?: string
    error?: SessionV1.Assistant["error"]
    completedAt?: number
    at?: number
    finish?: string
  } = {},
) {
  const sessions = yield* Session.Service
  const user: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    time: { created: Date.now() },
    model,
  }
  yield* sessions.updateMessage(user)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "do the work" })
  const at = options.at ?? Date.now()
  const info: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: at, ...(options.completedAt === undefined ? {} : { completed: options.completedAt }) },
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(options.error ? { error: options.error } : {}),
    ...(options.finish ? { finish: options.finish } : {}),
  }
  yield* sessions.updateMessage(info)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: info.id, type: "step-start" })
  if (options.text)
    yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: info.id, type: "text", text: options.text })
  const tools = options.tools ?? "mixed"
  if (tools !== false) {
    yield* Effect.promise(() => Bun.write(path.join(dir, "tool-runs"), "x"))
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: info.id,
      type: "tool",
      callID: "call_done",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "printf x >> tool-runs && printf tool-ran-once" },
        output: "tool-ran-once",
        title: "bash",
        metadata: {},
        time: { start: at, end: at },
      },
    })
    if (tools !== "completed")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: info.id,
        type: "tool",
        callID: "call_cut",
        tool: "bash",
        state:
          tools === "cancelled"
            ? { status: "error", input: { command: "sleep 600" }, error: "Tool execution aborted", metadata: { interrupted: true }, time: { start: at, end: at } }
            : { status: "running", input: { command: "sleep 600" }, metadata: { output: "partial line" }, time: { start: at } },
      })
  }
  return { user, assistant: info }
})

it.live(
  "a step interrupted after its tools completed resumes without a user message, keeping those results on the same step",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("resumed after restart")
          const session = yield* Session.use.create({ title: "Restart" })
          const seeded = yield* seedInterrupted(session, dir, { tools: "completed", text: "checking" })
          const capturedAt = Date.now()

          const result = yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt })
          expect(result.outcome).toBe("scheduled")
          expect(result.marker).toMatchObject({ restartID: RESTART, outcome: "scheduled", interruptedTools: 0 })

          const history = yield* idleWithReply(dir, session.id, "resumed after restart")
          expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)
          expect(yield* toolRuns(dir)).toBe("x")
          const anchor = history.find((message) => message.info.id === seeded.assistant.id)!
          expect(anchor.info.restarts).toEqual([result.marker!])
          expect(anchor.info.role === "assistant" && anchor.info.error?.name).toBe("MessageAbortedError")
          expect(anchor.parts.filter((part) => part.type === "tool").map((part) => part.type === "tool" && part.state.status)).toEqual(["completed"])

          const inputs = yield* llm.inputs
          expect(inputs).toHaveLength(1)
          const request = JSON.stringify(inputs[0])
          // The completed result is replayed from the interrupted step itself; no prompt is fabricated.
          expect(request).toContain("tool-ran-once")
          expect(request).toContain("checking")
          expect(request.split("do the work")).toHaveLength(2)
          expect(request).not.toContain("continue (the opencode daemon")
          expect(request).not.toContain(RESTART)

          // A lost acknowledgment re-sent after the drain moved on is recognized, not replayed.
          expect(yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt })).toEqual({
            outcome: "duplicate",
            marker: result.marker,
          })
          expect(yield* restartStatus(dir, session.id, seeded.assistant.id)).toEqual({ marker: result.marker, later: true })
          // An unknown restart identity learns nothing beyond whether the session moved on.
          expect(
            yield* requestInDirectory(`/session/${session.id}/restart?restartID=restart-other&anchorMessageID=${seeded.assistant.id}`, dir).pipe(
              Effect.flatMap((response) => response.json),
            ),
          ).toEqual({ later: true })
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a tool still running when the daemon died is left untouched and idle with an uncertain marker",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("must not be requested")
          const session = yield* Session.use.create({ title: "Unsafe" })
          const seeded = yield* seedInterrupted(session, dir)
          const before = yield* messages(dir, session.id)
          const capturedAt = Date.now()

          const result = yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt })
          expect(result).toMatchObject({
            outcome: "uncertain",
            marker: { restartID: RESTART, outcome: "uncertain", reason: "interrupted-tool", interruptedTools: 1 },
          })
          expect(yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt })).toEqual({
            outcome: "duplicate",
            marker: result.marker,
          })

          const after = yield* messages(dir, session.id)
          // Only the marker changed: the step stays unfinished and both tool parts keep their durable state.
          expect(after.map((message) => ({ ...message, info: { ...message.info, restarts: undefined } }))).toEqual(
            before.map((message) => ({ ...message, info: { ...message.info, restarts: undefined } })),
          )
          expect(after.find((message) => message.info.id === seeded.assistant.id)?.info.restarts).toEqual([result.marker!])
          expect(after.filter((message) => message.info.role === "user")).toHaveLength(1)
          const status = (yield* requestInDirectory("/session/status", dir).pipe(Effect.flatMap((r) => r.json))) as Record<string, { type: string }>
          expect(status[session.id]?.type ?? "idle").toBe("idle")
          expect(yield* toolRuns(dir)).toBe("x")
          expect(yield* llm.calls).toBe(0)

          // An abort stamped inside the restart window does not make a running tool's effect known.
          const windowed = yield* Session.use.create({ title: "Windowed abort" })
          const live = yield* seedInterrupted(windowed, dir, {
            error: new SessionV1.AbortedError({ message: "Aborted" }).toObject(),
            completedAt: Date.now(),
          })
          const windowedBefore = yield* messages(dir, windowed.id)
          expect(yield* resume(dir, windowed.id, { anchorMessageID: live.assistant.id, capturedAt })).toMatchObject({
            outcome: "uncertain",
            marker: { reason: "interrupted-tool", interruptedTools: 1 },
          })
          const strip = (history: typeof windowedBefore) =>
            history.map((message) => ({ ...message, info: { ...message.info, restarts: undefined } }))
          expect(strip(yield* messages(dir, windowed.id))).toEqual(strip(windowedBefore))
          expect(yield* toolRuns(dir)).toBe("x")
          expect(yield* llm.calls).toBe(0)

          // A graceful shutdown inside the restart window that cancelled a tool is just as unknown.
          const cancelled = yield* Session.use.create({ title: "Cancelled" })
          const cut = yield* seedInterrupted(cancelled, dir, {
            tools: "cancelled",
            error: new SessionV1.AbortedError({ message: "Aborted" }).toObject(),
            completedAt: Date.now(),
          })
          expect(yield* resume(dir, cancelled.id, { anchorMessageID: cut.assistant.id, capturedAt })).toMatchObject({
            outcome: "uncertain",
            marker: { reason: "interrupted-tool", interruptedTools: 1 },
          })
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "concurrent continuations of one restart start exactly one provider turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("only once").wait(held.promise).stop())
          const session = yield* Session.use.create({ title: "Race" })
          const seeded = yield* seedInterrupted(session, dir, { tools: "completed" })
          const body = { anchorMessageID: seeded.assistant.id, capturedAt: Date.now() }

          const outcomes = yield* Effect.forEach(Array.from({ length: 6 }), () => resume(dir, session.id, body), {
            concurrency: "unbounded",
          })
          expect(outcomes.filter((item) => item.outcome === "scheduled")).toHaveLength(1)
          expect(outcomes.filter((item) => item.outcome !== "scheduled").every((item) => item.outcome === "duplicate")).toBe(true)
          yield* llm.wait(1)
          held.resolve()
          const history = yield* idleWithReply(dir, session.id, "only once")
          expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)
          expect(history.find((message) => message.info.id === seeded.assistant.id)?.info.restarts).toHaveLength(1)
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "sessions that moved on, failed, or finished are reported without a marker or provider turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const capturedAt = Date.now()

          const advanced = yield* Session.use.create({ title: "Advanced" })
          const moved = yield* seedInterrupted(advanced, dir)
          yield* sessions.updateMessage({ ...moved.user, id: MessageID.ascending(), time: { created: Date.now() + 1 } })
          expect(yield* resume(dir, advanced.id, { anchorMessageID: moved.assistant.id, capturedAt })).toEqual({ outcome: "advanced" })

          const failedSession = yield* Session.use.create({ title: "Failed" })
          const failed = yield* seedInterrupted(failedSession, dir, {
            tools: false,
            completedAt: capturedAt - 1,
            error: new SessionV1.APIError({ message: "boom", statusCode: 403, isRetryable: false }).toObject(),
          })
          expect(yield* resume(dir, failedSession.id, { anchorMessageID: failed.assistant.id, capturedAt })).toEqual({ outcome: "failed" })

          const doneSession = yield* Session.use.create({ title: "Done" })
          const done = yield* seedInterrupted(doneSession, dir, { tools: false, text: "all done", completedAt: capturedAt, finish: "stop" })
          expect(yield* resume(dir, doneSession.id, { anchorMessageID: done.assistant.id, capturedAt })).toEqual({ outcome: "complete" })

          for (const [session, anchor] of [
            [advanced, moved.assistant.id],
            [failedSession, failed.assistant.id],
            [doneSession, done.assistant.id],
          ] as const) {
            const history = yield* messages(dir, session.id)
            expect(history.find((message) => message.info.id === anchor)?.info.restarts).toBeUndefined()
          }
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "an abort predating the restart or a future-dated anchor stays idle with a visible uncertain marker",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const capturedAt = Date.now()
          const aborted = new SessionV1.AbortedError({ message: "Aborted" }).toObject()

          const stopped = yield* Session.use.create({ title: "Stopped" })
          const human = yield* seedInterrupted(stopped, dir, { tools: false, error: aborted, completedAt: capturedAt - 5_000 })
          const first = yield* resume(dir, stopped.id, { anchorMessageID: human.assistant.id, capturedAt })
          expect(first).toMatchObject({ outcome: "uncertain", marker: { outcome: "uncertain", reason: "aborted" } })
          expect(yield* resume(dir, stopped.id, { anchorMessageID: human.assistant.id, capturedAt })).toEqual({
            outcome: "duplicate",
            marker: first.marker,
          })

          const skewed = yield* Session.use.create({ title: "Skewed" })
          const future = yield* seedInterrupted(skewed, dir, { at: Date.now() + 3_600_000 })
          expect(yield* resume(dir, skewed.id, { anchorMessageID: future.assistant.id, capturedAt })).toMatchObject({
            outcome: "uncertain",
            marker: { reason: "out-of-order" },
          })
          const history = yield* messages(dir, skewed.id)
          const cut = history.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.callID === "call_cut")
          expect(cut?.type === "tool" && cut.state.status).toBe("running")
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "an abort inside the restart window resumes, and a text-only interrupted step is regenerated rather than prefilled",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("regenerated answer")
          const capturedAt = Date.now() - 1_000
          const session = yield* Session.use.create({ title: "Graceful" })
          const seeded = yield* seedInterrupted(session, dir, {
            tools: false,
            text: "half-written sent",
            error: new SessionV1.AbortedError({ message: "Aborted" }).toObject(),
            completedAt: Date.now(),
          })
          expect((yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt })).outcome).toBe("scheduled")
          const history = yield* idleWithReply(dir, session.id, "regenerated answer")
          expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)
          expect(history.some((message) => message.parts.some((part) => part.type === "text" && part.text === "half-written sent"))).toBe(true)
          const request = JSON.stringify((yield* llm.inputs)[0])
          expect(request).toContain("do the work")
          expect(request).not.toContain("half-written sent")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "an anchor that absorbed the maximum restarts refuses a new restart ID and still recognizes every old one",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const capturedAt = Date.now()
          const session = yield* Session.use.create({ title: "Capacity" })
          const seeded = yield* seedInterrupted(session, dir)
          const ids = Array.from({ length: SessionRestart.MAX_MARKERS }, (_, index) => `${RESTART}-${index}`)
          const markers = yield* Effect.forEach(ids, (restartID) =>
            resume(dir, session.id, { restartID, anchorMessageID: seeded.assistant.id, capturedAt }),
          )
          expect(markers.map((result) => result.outcome)).toEqual(ids.map(() => "uncertain"))
          expect(yield* resume(dir, session.id, { restartID: `${RESTART}-new`, anchorMessageID: seeded.assistant.id, capturedAt })).toEqual({
            outcome: "capacity",
          })
          for (const [index, restartID] of ids.entries())
            expect(yield* resume(dir, session.id, { restartID, anchorMessageID: seeded.assistant.id, capturedAt })).toEqual({
              outcome: "duplicate",
              marker: markers[index]!.marker,
            })
          const anchor = (yield* messages(dir, session.id)).find((message) => message.info.id === seeded.assistant.id)
          expect(anchor?.info.restarts?.map((marker) => marker.restartID)).toEqual(ids)
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

// An empty assistant header opened after the restart anchor was captured: the daemon died between
// creating the step and the first provider output (a crash during the model step).
const seedEmptyHeader = Effect.fn("test.seedEmptyHeader")(function* (session: Session.Info, dir: string, parentID: MessageID, extra: Partial<SessionV1.Assistant> = {}) {
  const sessions = yield* Session.Service
  const info: SessionV1.Assistant = {
    id: MessageID.ascending(), sessionID: session.id, role: "assistant", parentID, agent: "build", mode: "build",
    modelID: model.modelID, providerID: model.providerID, time: { created: Date.now() }, path: { cwd: dir, root: dir },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra,
  }
  yield* sessions.updateMessage(info)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: info.id, type: "step-start" })
  return info
})

it.live(
  "an empty step opened after the anchor during shutdown is not progress: the turn resumes once and the step is closed",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("resumed past the empty step")
          const session = yield* Session.use.create({ title: "Empty header" })
          const seeded = yield* seedInterrupted(session, dir, { tools: "completed", finish: "tool-calls", completedAt: Date.now() })
          const capturedAt = Date.now()
          // Captured anchor: the finished tool step. The runner then opened the next step and the daemon died.
          const header = yield* seedEmptyHeader(session, dir, seeded.user.id)

          const result = yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt })
          expect(result.outcome).toBe("scheduled")
          const history = yield* idleWithReply(dir, session.id, "resumed past the empty step")
          const closed = history.find((message) => message.info.id === header.id)!
          expect(closed.info.role === "assistant" && closed.info.error?.name).toBe("MessageAbortedError")
          expect(closed.info.role === "assistant" && closed.info.time.completed).toBeGreaterThan(0)
          expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)
          expect(yield* toolRuns(dir)).toBe("x")
          expect(yield* llm.inputs).toHaveLength(1)
          expect(yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt })).toEqual({ outcome: "duplicate", marker: result.marker })
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a step with output, a tool, or a deliberate abort after the anchor still means the session advanced",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("must not be requested")
          for (const extra of [
            { text: "partial answer" },
            { error: new SessionV1.AbortedError({ message: "Aborted" }).toObject() },
          ]) {
            const session = yield* Session.use.create({ title: "Advanced" })
            const seeded = yield* seedInterrupted(session, dir, { tools: "completed", finish: "tool-calls", completedAt: Date.now() })
            const header = yield* seedEmptyHeader(session, dir, seeded.user.id, "error" in extra ? { error: extra.error, time: { created: Date.now(), completed: Date.now() } } : {})
            if ("text" in extra)
              yield* Session.Service.use((sessions) => sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: header.id, type: "text", text: extra.text ?? "" }))
            expect((yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt: Date.now() })).outcome).toBe("advanced")
          }
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

const recover = (dir: string, sessionID: string, body: { recoveryID: string; anchorMessageID: string; text?: string; run?: boolean }) =>
  requestInDirectory(`/session/${sessionID}/recover`, dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Recovery: inspect the test log, rerun verification only.", reason: "reviewed: read-only test run", sender: "handoff-reliability", ...body }),
  }).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
    Effect.flatMap((response) => response.json),
    Effect.map((value) => Schema.decodeUnknownSync(SessionRestart.RecoverResult)(value)),
  )

it.live(
  "operator recovery records an unknown tool as abandoned, never reruns it, and runs the typed intent once",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("recovered by operator intent")
          const session = yield* Session.use.create({ title: "Operator recovery" })
          const seeded = yield* seedInterrupted(session, dir)
          // Restart continuation correctly refuses this anchor.
          expect((yield* resume(dir, session.id, { anchorMessageID: seeded.assistant.id, capturedAt: Date.now() })).outcome).toBe("uncertain")

          const result = yield* recover(dir, session.id, { recoveryID: "recovery-1", anchorMessageID: seeded.assistant.id })
          expect(result).toMatchObject({ outcome: "scheduled", abandonedTools: 1, marker: { reason: "operator-recovery", interruptedTools: 1 } })
          const history = yield* idleWithReply(dir, session.id, "recovered by operator intent")
          const anchor = history.find((message) => message.info.id === seeded.assistant.id)!
          const states = anchor.parts.flatMap((part) => (part.type === "tool" ? [[part.callID, part.state.status]] : []))
          expect(states).toEqual([["call_done", "completed"], ["call_cut", "error"]])
          const cut = anchor.parts.find((part) => part.type === "tool" && part.callID === "call_cut")!
          expect(cut.type === "tool" && cut.state.status === "error" && cut.state.error).toContain("effect is unknown and was not repeated")
          // The intent is sourced input, not a human prompt; the tool's effect was not repeated.
          const intent = history.find((message) => message.info.role === "user" && "source" in message.info && message.info.source?.kind === "recovery")
          expect(intent).toBeDefined()
          expect(yield* toolRuns(dir)).toBe("x")
          expect(yield* llm.inputs).toHaveLength(1)
          expect(JSON.stringify((yield* llm.inputs)[0])).toContain("Recovery: inspect the test log")

          expect(yield* recover(dir, session.id, { recoveryID: "recovery-1", anchorMessageID: seeded.assistant.id })).toMatchObject({ outcome: "duplicate" })
          expect((yield* recover(dir, session.id, { recoveryID: "recovery-2", anchorMessageID: seeded.assistant.id })).outcome).toBe("advanced")
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "operator recovery refuses failed, finished and moved-on sessions without writing",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const failedSession = yield* Session.use.create({ title: "Failed" })
          const failed = yield* seedInterrupted(failedSession, dir, { tools: false, completedAt: Date.now(),
            error: new SessionV1.APIError({ message: "boom", isRetryable: false }).toObject() })
          expect((yield* recover(dir, failedSession.id, { recoveryID: "r-failed", anchorMessageID: failed.assistant.id })).outcome).toBe("failed")
          const doneSession = yield* Session.use.create({ title: "Done" })
          const done = yield* seedInterrupted(doneSession, dir, { tools: false, finish: "stop", completedAt: Date.now() })
          expect((yield* recover(dir, doneSession.id, { recoveryID: "r-done", anchorMessageID: done.assistant.id })).outcome).toBe("complete")
          const movedSession = yield* Session.use.create({ title: "Moved" })
          const moved = yield* seedInterrupted(movedSession, dir)
          const before = yield* messages(dir, movedSession.id)
          yield* Session.Service.use((sessions) => sessions.updateMessage({ ...moved.user, id: MessageID.ascending(), time: { created: Date.now() } }))
          expect((yield* recover(dir, movedSession.id, { recoveryID: "r-moved", anchorMessageID: moved.assistant.id })).outcome).toBe("advanced")
          const after = yield* messages(dir, movedSession.id)
          expect(after.find((m) => m.info.id === moved.assistant.id)).toEqual(before.find((m) => m.info.id === moved.assistant.id))
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a session created through a symlinked directory recovers and resumes from either spelling",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const link = `${dir}-link`
          yield* Effect.promise(() => import("fs/promises").then((fs) => fs.symlink(dir, link)))
          yield* Effect.addFinalizer(() => Effect.promise(() => import("fs/promises").then((fs) => fs.rm(link, { force: true }))))
          yield* llm.text("recovered through the link")
          yield* llm.text("queued input answered")

          // The V2 create keeps the caller's spelling, as live sessions created under ~/editspaces do.
          const created = yield* requestInDirectory("/api/session", link, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ location: { directory: link }, title: "Symlinked" }),
          }).pipe(Effect.flatMap((response) => response.json))
          const sessionID = (created as { data: { id: string } }).data.id
          const session = yield* Session.use.get(sessionID as never)
          expect(session.directory).toBe(link)
          const seeded = yield* seedInterrupted(session, dir, { tools: "cancelled" })

          const first = yield* recover(link, sessionID, { recoveryID: "link-recovery", anchorMessageID: seeded.assistant.id })
          expect(first.outcome).toBe("scheduled")
          // The same recovery from the realpath spelling reaches the same Session state, not a second instance.
          expect((yield* recover(dir, sessionID, { recoveryID: "link-recovery", anchorMessageID: seeded.assistant.id })).outcome).toBe("duplicate")
          yield* idleWithReply(dir, sessionID, "recovered through the link")

          const queued = yield* requestInDirectory(`/session/${sessionID}/input`, link, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestID: "link-queued", delivery: "queue", text: "queued through the link" }),
          })
          expect(queued.status).toBe(200)
          const history = yield* idleWithReply(link, sessionID, "queued input answered")
          expect(history.some((message) => message.parts.some((part) => part.type === "text" && part.text === "queued through the link"))).toBe(true)
        }),
      { config: testProviderConfig },
    ),
  60_000,
)

it.live(
  "recover run:false closes the interrupted step and turn once, runs nothing and leaves queued input pending",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("must not be requested")
          const session = yield* Session.use.create({ title: "Close only" })
          const seeded = yield* seedInterrupted(session, dir)
          const started = yield* Session.Service.use((sessions) => sessions.turnStarted(session.id))
          // Input queued while the step was unfinished: an advisory wake never promotes it.
          const queued = yield* requestInDirectory(`/session/${session.id}/input`, dir, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestID: "queued-1", delivery: "queue", text: "after you recover" }),
          }).pipe(Effect.flatMap((response) => response.json))
          expect(queued).toMatchObject({ state: "pending" })
          const before = (yield* messages(dir, session.id)).length

          const result = yield* recover(dir, session.id, { recoveryID: "close-1", anchorMessageID: seeded.assistant.id, run: false })
          expect(result).toMatchObject({ outcome: "closed", abandonedTools: 1, marker: { reason: "operator-recovery", interruptedTools: 1, closed: true } })

          const history = yield* messages(dir, session.id)
          expect(history).toHaveLength(before)
          const anchor = history.find((message) => message.info.id === seeded.assistant.id)!
          expect(anchor.info.role === "assistant" && anchor.info.error?.name).toBe("MessageAbortedError")
          expect(anchor.info.role === "assistant" && anchor.info.time.completed).toBeGreaterThan(0)
          const cut = anchor.parts.find((part) => part.type === "tool" && part.callID === "call_cut")!
          expect(cut.type === "tool" && cut.state.status === "error" && cut.state.error).toContain("effect is unknown and was not repeated")
          expect(history.some((message) => message.info.role === "user" && "source" in message.info && message.info.source?.kind === "recovery")).toBe(false)
          const info = (yield* requestInDirectory(`/session/${session.id}`, dir).pipe(Effect.flatMap((r) => r.json))) as Session.Info
          expect(info.time.turn?.started).toBe(started)
          expect(info.time.turn?.ended).toBeGreaterThanOrEqual(started)
          const receipt = yield* requestInDirectory(`/session/${session.id}/input/queued-1`, dir).pipe(Effect.flatMap((r) => r.json))
          expect(receipt).toMatchObject({ state: "pending" })

          // Exactly once: the same request is a duplicate; the other mode with this ID is refused.
          expect(yield* recover(dir, session.id, { recoveryID: "close-1", anchorMessageID: seeded.assistant.id, run: false })).toMatchObject({ outcome: "duplicate", marker: result.marker })
          expect(yield* recover(dir, session.id, { recoveryID: "close-1", anchorMessageID: seeded.assistant.id })).toMatchObject({ outcome: "conflict" })
          const after = yield* messages(dir, session.id)
          expect(after.find((m) => m.info.id === seeded.assistant.id)?.info).toEqual(anchor.info)
          expect(yield* toolRuns(dir)).toBe("x")
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "after recover run:false, the next queued input wakes the session and every waiting input is answered",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          // A human queued input runs alone at an idle boundary, so the two waiting inputs take two turns.
          yield* llm.text("answered the earlier input")
          yield* llm.text("new work after the close")
          const session = yield* Session.use.create({ title: "Close then new work" })
          const seeded = yield* seedInterrupted(session, dir)
          const queue = (requestID: string, text: string) =>
            requestInDirectory(`/session/${session.id}/input`, dir, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ requestID, delivery: "queue", text }),
            }).pipe(Effect.flatMap((response) => response.json))
          expect(yield* queue("before-close", "waiting since the crash")).toMatchObject({ state: "pending" })
          expect((yield* recover(dir, session.id, { recoveryID: "close-w", anchorMessageID: seeded.assistant.id, run: false })).outcome).toBe("closed")
          expect(yield* llm.calls).toBe(0)

          // The closed step is settled, so new owner work must not stay stuck behind it.
          yield* queue("after-close", "follow-up from the owner")
          const history = yield* idleWithReply(dir, session.id, "new work after the close")
          const texts = history.flatMap((message) =>
            message.info.role === "user" ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
          )
          expect(texts).toContain("waiting since the crash")
          expect(texts).toContain("follow-up from the owner")
          expect(yield* toolRuns(dir)).toBe("x")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a recovery ID used to run cannot later close, and a finished session is refused by run:false without writing",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("recovered by operator intent")
          const session = yield* Session.use.create({ title: "Run then close" })
          const seeded = yield* seedInterrupted(session, dir)
          expect((yield* recover(dir, session.id, { recoveryID: "run-1", anchorMessageID: seeded.assistant.id })).outcome).toBe("scheduled")
          yield* idleWithReply(dir, session.id, "recovered by operator intent")
          const before = yield* messages(dir, session.id)
          expect(yield* recover(dir, session.id, { recoveryID: "run-1", anchorMessageID: seeded.assistant.id, run: false })).toMatchObject({ outcome: "conflict" })
          expect((yield* recover(dir, session.id, { recoveryID: "close-2", anchorMessageID: seeded.assistant.id, run: false })).outcome).toBe("advanced")
          expect(yield* messages(dir, session.id)).toEqual(before)
          expect(yield* llm.calls).toBe(1)

          const done = yield* Session.use.create({ title: "Done" })
          const finished = yield* seedInterrupted(done, dir, { tools: false, finish: "stop", completedAt: Date.now() })
          expect((yield* recover(dir, done.id, { recoveryID: "close-3", anchorMessageID: finished.assistant.id, run: false })).outcome).toBe("complete")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a repeated close settles a turn that a crash left open after the marker was written",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "Close retry" })
          const seeded = yield* seedInterrupted(session, dir)
          expect((yield* recover(dir, session.id, { recoveryID: "close-r", anchorMessageID: seeded.assistant.id, run: false })).outcome).toBe("closed")
          // Simulate a crash after the marker: a turn is open again with no end.
          const started = yield* Session.Service.use((sessions) => sessions.turnStarted(session.id))
          expect(yield* recover(dir, session.id, { recoveryID: "close-r", anchorMessageID: seeded.assistant.id, run: false })).toMatchObject({ outcome: "duplicate" })
          const info = (yield* requestInDirectory(`/session/${session.id}`, dir).pipe(Effect.flatMap((r) => r.json))) as Session.Info
          expect(info.time.turn).toMatchObject({ started })
          expect(info.time.turn?.ended).toBeGreaterThanOrEqual(started)
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

// A lost server process (OOM, crash) leaves the newest step open with no runner and no restart manifest.
// Rows the lost process wrote: all recorded activity predates this server process.
const before = () => Date.now() - 10 * 60_000

const queueMail = (dir: string, sessionID: string, requestID: string, text: string) =>
  requestInDirectory(`/session/${sessionID}/input`, dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestID, delivery: "queue", text, source: { type: "editspace-mail", id: requestID, sender: "owner", recipient: "worker" } }),
  }).pipe(Effect.flatMap((response) => response.json))

it.live(
  "after a lost process, a step whose tools all completed lets the waiting input start the next turn once, never re-running the tool",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("continued after the crash")
          const session = yield* Session.use.create({ title: "Orphan durable" })
          const seeded = yield* seedInterrupted(session, dir, { tools: "completed", text: "checking", at: before() })
          expect(yield* queueMail(dir, session.id, "resume-1", "resume your task")).toMatchObject({ state: "pending" })
          const history = yield* idleWithReply(dir, session.id, "continued after the crash")
          const promoted = history.find((message) => message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.text === "resume your task"))
          expect(promoted).toBeDefined()
          // The open step is kept as it was: same id, its completed tool untouched and not re-run.
          const anchor = history.find((message) => message.info.id === seeded.assistant.id)!
          expect(anchor.parts.filter((part) => part.type === "tool").map((part) => part.type === "tool" && part.state.status)).toEqual(["completed"])
          expect(yield* toolRuns(dir)).toBe("x")
          expect(yield* llm.calls).toBe(1)
          // The receipt keeps its request ID and links the user message it became.
          const receipt = (yield* requestInDirectory(`/session/${session.id}/input/resume-1`, dir).pipe(Effect.flatMap((r) => r.json))) as { state: string; messageID?: string }
          expect(receipt.state).not.toBe("pending")
          expect(receipt.messageID).toBe(promoted!.info.id)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "after a lost process, an empty open step lets the waiting input start the next turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("answered after an empty step")
          const session = yield* Session.use.create({ title: "Orphan empty" })
          yield* seedInterrupted(session, dir, { tools: false, at: before() })
          yield* queueMail(dir, session.id, "resume-2", "go on")
          yield* idleWithReply(dir, session.id, "answered after an empty step")
          expect(yield* llm.calls).toBe(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "after a lost process, unknown effects, explicit stops and provider failures keep the waiting input pending",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("must not be requested")
          const cases = [
            { title: "running tool", options: { tools: "mixed" as const, at: before() } },
            { title: "interrupted tool", options: { tools: "cancelled" as const, at: before() } },
            { title: "stopped", options: { tools: "completed" as const, at: before(), error: { name: "MessageAbortedError", data: { message: "stopped" } } as never } },
            // Opened after this process started: possibly still streaming in a live runner, never an orphan.
            { title: "fresh open text step", options: { tools: false as const, text: "streaming" } },
            { title: "provider failure", options: { tools: false as const, at: before(), error: { name: "APIError", data: { message: "boom", isRetryable: false } } as never } },
          ]
          const sessions = []
          for (const item of cases) {
            const session = yield* Session.use.create({ title: item.title })
            yield* seedInterrupted(session, dir, item.options)
            expect(yield* queueMail(dir, session.id, `hold-${sessions.length}`, "resume")).toMatchObject({ state: "pending" })
            sessions.push(session.id)
          }
          yield* Effect.sleep("3 seconds")
          for (const [index, sessionID] of sessions.entries()) {
            const receipt = yield* requestInDirectory(`/session/${sessionID}/input/hold-${index}`, dir).pipe(Effect.flatMap((r) => r.json))
            expect({ case: cases[index]!.title, state: (receipt as { state: string }).state }).toEqual({ case: cases[index]!.title, state: "pending" })
          }
          expect(yield* llm.calls).toBe(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

// Shapes recorded on a real Linux OOM (Personal, 2026-11-05; metadata only): "native" ended its step with
// finish tool-calls after a completed bash; "core" had a completed-tool step and then an empty step with no parts.
it.live(
  "after a lost process, the recorded OOM shapes (completed tool-calls step; empty follow-up step) let waiting input continue",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("native continued")
          yield* llm.text("core continued")
          const native = yield* Session.use.create({ title: "native shape" })
          yield* seedInterrupted(native, dir, { tools: "completed", finish: "tool-calls", at: before(), completedAt: before() })
          const core = yield* Session.use.create({ title: "core shape" })
          const at = before()
          const seeded = yield* seedInterrupted(core, dir, { tools: "completed", finish: "tool-calls", at, completedAt: at })
          yield* Session.Service.use((sessions) =>
            sessions.updateMessage({ ...seeded.assistant, id: MessageID.ascending(), time: { created: at + 1 }, finish: undefined }),
          )
          yield* queueMail(dir, native.id, "native-1", "resume")
          yield* idleWithReply(dir, native.id, "native continued")
          yield* queueMail(dir, core.id, "core-1", "resume")
          yield* idleWithReply(dir, core.id, "core continued")
          expect(yield* llm.calls).toBe(2)
          expect(yield* toolRuns(dir)).toBe("x")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

const incidentFiles = (restartDir: string) =>
  Effect.promise(async () => {
    const { readdir, readFile } = await import("fs/promises")
    const names = (await readdir(restartDir).catch(() => [] as string[])).filter((name) => name.endsWith(".incident-source.json"))
    return Promise.all(names.map(async (name) => ({ name, body: JSON.parse(await readFile(path.join(restartDir, name), "utf8")) })))
  })

const withRestartDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OC_RESTART_DIR
      process.env.OC_RESTART_DIR = path.join(dir, "restarts")
      return previous
    }),
    () => effect,
    (previous) => Effect.sync(() => {
      if (previous === undefined) delete process.env.OC_RESTART_DIR
      else process.env.OC_RESTART_DIR = previous
    }),
  )

it.live(
  "a held orphan records one crash-observed incident source per session, write-once, and never for a durable orphan",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        withRestartDir(
          dir,
          Effect.gen(function* () {
            yield* llm.text("durable continued")
            const held = yield* Session.use.create({ title: "held" })
            const heldStep = yield* seedInterrupted(held, dir, { tools: "mixed", at: before() })
            const second = yield* Session.use.create({ title: "held 2" })
            yield* seedInterrupted(second, dir, { tools: "cancelled", at: before() })
            const stopped = yield* Session.use.create({ title: "stopped" })
            yield* seedInterrupted(stopped, dir, { tools: false, at: before(), error: { name: "MessageAbortedError", data: { message: "stopped" } } as never })
            const durable = yield* Session.use.create({ title: "durable" })
            yield* seedInterrupted(durable, dir, { tools: "completed", at: before() })

            yield* queueMail(dir, held.id, "h-1", "resume")
            yield* queueMail(dir, second.id, "h-2", "resume")
            yield* queueMail(dir, stopped.id, "s-1", "resume")
            yield* queueMail(dir, durable.id, "d-1", "resume")
            yield* idleWithReply(dir, durable.id, "durable continued")
            // A second refusal in the same process generation adds nothing.
            yield* queueMail(dir, held.id, "h-3", "again")
            const files = yield* pollWithTimeout(
              incidentFiles(path.join(dir, "restarts")).pipe(Effect.map((list) => (list.length >= 3 ? list : undefined))),
              "incident sources were not written",
            )
            yield* Effect.sleep("1 second")
            const final = yield* incidentFiles(path.join(dir, "restarts"))
            expect(final).toHaveLength(3)
            const bySession = Object.fromEntries(final.map((file) => [file.body.session.session, file.body]))
            expect(Object.keys(bySession).sort()).toEqual([held.id, second.id, stopped.id].sort())
            expect(bySession[stopped.id].session.reason).toBe("explicit-stop")
            // Names follow the dispatcher's crash-<generation>-<session>.incident-source.json and files are private.
            for (const file of final) {
              expect(file.name).toMatch(/^crash-\d{1,16}-\d{1,10}-ses_[A-Za-z0-9]{1,64}\.incident-source\.json$/)
              const { statSync } = yield* Effect.promise(() => import("fs"))
              expect(statSync(path.join(dir, "restarts", file.name)).mode & 0o777).toBe(0o600)
            }
            const body = bySession[held.id]
            expect(body).toMatchObject({ kind: "crash-observed", version: 1, source: "core-wake-guard", previous_generation: null, core_binary_sha256: null })
            expect(body.session).toMatchObject({ anchor: heldStep.assistant.id, reason: "unknown-effect", fenced: false, lane: null, recorded_owner: null })
            expect(body.session.tools).toEqual([{ tool: "bash", status: "completed" }, { tool: "bash", status: "running" }])
            expect(body.session.pending_inputs).toBeGreaterThanOrEqual(1)
            expect(JSON.stringify(body)).not.toContain("sleep 600")
            expect("capturedAt" in body || "manifest" in body).toBe(false)
            expect(files.every((file) => file.name.startsWith(`crash-${body.generation}-`))).toBe(true)
            // The held sessions still hold: their inputs stay pending and no provider call ran for them.
            expect(yield* llm.calls).toBe(1)
          }),
        ),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a fresh open step newer than this process is not a crash orphan and records nothing",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        withRestartDir(
          dir,
          Effect.gen(function* () {
            yield* llm.text("must not be requested")
            const session = yield* Session.use.create({ title: "fresh" })
            yield* seedInterrupted(session, dir, { tools: "mixed" })
            yield* queueMail(dir, session.id, "f-1", "resume")
            yield* Effect.sleep("2 seconds")
            expect(yield* incidentFiles(path.join(dir, "restarts"))).toEqual([])
          }),
        ),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a prompt promoted before a lost process opened its step holds and records the prompt as the anchor",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        withRestartDir(
          dir,
          Effect.gen(function* () {
            yield* llm.text("must not be requested")
            const session = yield* Session.use.create({ title: "no step" })
            const user: SessionV1.User = { id: MessageID.ascending(), sessionID: session.id, role: "user", agent: "build", time: { created: before() }, model }
            yield* Session.Service.use((sessions) => sessions.updateMessage(user))
            yield* Session.Service.use((sessions) => sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "do the work" }))
            yield* queueMail(dir, session.id, "n-1", "resume")
            const files = yield* pollWithTimeout(
              incidentFiles(path.join(dir, "restarts")).pipe(Effect.map((list) => (list.length ? list : undefined))),
              "incident source was not written",
            )
            expect(files).toHaveLength(1)
            expect(files[0]!.body.session).toMatchObject({ session: session.id, anchor: user.id, reason: "unknown-effect", tools: [] })
            expect(yield* requestInDirectory(`/session/${session.id}/input/n-1`, dir).pipe(Effect.flatMap((r) => r.json))).toMatchObject({ state: "pending" })
            expect(yield* llm.calls).toBe(0)
          }),
        ),
      { config: testProviderConfig },
    ),
  90_000,
)

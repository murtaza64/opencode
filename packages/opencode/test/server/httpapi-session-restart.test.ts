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

const recover = (dir: string, sessionID: string, body: { recoveryID: string; anchorMessageID: string; text?: string }) =>
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

import { afterEach, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionNudge } from "@/session/nudge"
import { SessionInput } from "@/session/input"
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
    AppNodeBuilder.build(SessionInput.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const post = (dir: string, path: string, body: unknown) =>
  requestInDirectory(path, dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const nudge = (dir: string, sessionID: string, requestID: string, observedMessageID: string) =>
  post(dir, `/session/${sessionID}/nudge`, { requestID, observedMessageID }).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => Schema.decodeUnknownSync(SessionNudge.Result)(body)),
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
    "nudged turn did not finish",
    "45 seconds",
  )

const toolRuns = (dir: string) => Effect.promise(() => Bun.file(path.join(dir, "tool-runs")).text().catch(() => ""))

type Tool = "completed" | "interrupted" | "running" | "tool-error"

// Seeds one user prompt and one assistant step; `tool` adds a bash call in that typed state.
const seed = Effect.fn("test.seedNudgeHistory")(function* (
  session: Session.Info,
  assistant: { finish?: string; error?: SessionV1.Assistant["error"]; tool?: Tool; text?: string } | false,
) {
  const sessions = yield* Session.Service
  const user: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    time: { created: Date.now() },
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
  }
  yield* sessions.updateMessage(user)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "seed" })
  if (!assistant) return user
  const now = Date.now()
  const info: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    time: { created: now, completed: now },
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(assistant.error ? { error: assistant.error } : {}),
    ...(assistant.finish ? { finish: assistant.finish } : {}),
  }
  yield* sessions.updateMessage(info)
  if (assistant.text)
    yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: info.id, type: "text", text: assistant.text })
  const input = { command: "printf x >> tool-runs && printf seeded-output", description: "Side effect" }
  const state: SessionV1.ToolPart["state"] | undefined =
    assistant.tool === "completed"
      ? { status: "completed", input, output: "seeded-output", title: "bash", metadata: {}, time: { start: now, end: now } }
      : assistant.tool === "tool-error"
        ? { status: "error", input, error: "exit status 1", metadata: {}, time: { start: now, end: now } }
        : assistant.tool === "interrupted"
          ? { status: "error", input, error: "Tool execution aborted", metadata: { interrupted: true }, time: { start: now, end: now } }
          : assistant.tool === "running"
            ? { status: "running", input, title: "bash", metadata: {}, time: { start: now } }
            : undefined
  if (state)
    yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: info.id, type: "tool", callID: "call_seed", tool: "bash", state })
  return info
})

const aborted = () => new SessionV1.AbortedError({ message: "Aborted" }).toObject()
const apiError = () => new SessionV1.APIError({ message: "boom", statusCode: 500, isRetryable: false }).toObject()

it.live(
  "a tool-calls tail with durable results resumes with one provider turn, no new user message and no tool re-run",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("resumed after tools")
          const session = yield* Session.use.create({ title: "Resume" })
          const tail = yield* seed(session, { finish: "tool-calls", tool: "completed" })

          expect(yield* nudge(dir, session.id, "req-resume", tail.id)).toEqual({ outcome: "started", requestID: "req-resume" })
          const history = yield* idleWithReply(dir, session.id, "resumed after tools")
          expect(yield* llm.inputs).toHaveLength(1)
          expect(JSON.stringify((yield* llm.inputs)[0])).toContain("seeded-output")
          expect(history.filter((message) => message.info.role === "user")).toHaveLength(1)
          expect(history.find((message) => message.info.id === tail.id)?.info.nudges).toMatchObject([{ requestID: "req-resume", mode: "resume" }])
          expect(yield* toolRuns(dir)).toBe("")

          // A lost acknowledgment re-sent with the same body gets its real outcome and starts nothing.
          expect(yield* nudge(dir, session.id, "req-resume", tail.id)).toEqual({ outcome: "started", requestID: "req-resume" })
          const reused = yield* post(dir, `/session/${session.id}/nudge`, { requestID: "req-resume", observedMessageID: history.at(-1)!.info.id })
          expect(reused.status).toBe(409)
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a naturally finished turn continues through one sourced Nudge input that is settled once presented",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("continued on nudge")
          const session = yield* Session.use.create({ title: "Finished" })
          const tail = yield* seed(session, { finish: "stop", text: "all done" })

          const result = yield* nudge(dir, session.id, "req-finished", tail.id)
          expect(result).toMatchObject({ outcome: "started", requestID: "req-finished" })
          const history = yield* idleWithReply(dir, session.id, "continued on nudge")
          const users = history.filter((message) => message.info.role === "user")
          expect(users).toHaveLength(2)
          const nudged = users.at(-1)!
          expect(result.messageID).toBe(nudged.info.id)
          expect(nudged.info.role === "user" && nudged.info.source).toMatchObject({
            type: "editspace-mail",
            kind: "nudge",
            sender: "human (Nudge)",
            id: "nudge:req-finished",
          })
          expect(yield* llm.inputs).toHaveLength(1)
          // The model sees the fixed literal under the lower-trust mail wrapper, never as human prose.
          expect(JSON.stringify((yield* llm.inputs)[0])).toContain("Peer agent mail")
          expect(JSON.stringify((yield* llm.inputs)[0])).toContain("Continue.")

          // Settled on presentation, so it never holds the session against retention as unanswered mail.
          const receipt = yield* pollWithTimeout(
            requestInDirectory(`/session/${session.id}/input/nudge:req-finished`, dir).pipe(
              Effect.flatMap((response) => response.json),
              Effect.map((body) => body as { state: string; disposition?: string }),
              Effect.map((body) => (body.state === "handled" ? body : undefined)),
            ),
            "nudge input was not settled",
            "20 seconds",
          )
          expect(receipt.disposition).toBe("acknowledged")

          expect(yield* nudge(dir, session.id, "req-finished", tail.id)).toEqual({
            outcome: "started",
            requestID: "req-finished",
            messageID: nudged.info.id,
          })
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "unknown tool effects, aborted, unfinished and failed tails are refused without a provider call or a write",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const cases: { name: string; assistant: Parameters<typeof seed>[1]; outcome: SessionNudge.Outcome }[] = [
            { name: "interrupted", assistant: { error: aborted(), tool: "interrupted" as const }, outcome: "uncertain" },
            { name: "interrupted-on-finished", assistant: { finish: "tool-calls", tool: "interrupted" as const }, outcome: "uncertain" },
            { name: "running", assistant: { finish: "tool-calls", tool: "running" as const }, outcome: "uncertain" },
            { name: "stop-during-prose", assistant: { error: aborted(), text: "partial" }, outcome: "uncertain" },
            { name: "aborted-after-tools", assistant: { error: aborted(), tool: "completed" as const }, outcome: "uncertain" },
            { name: "unfinished", assistant: { tool: "completed" as const }, outcome: "uncertain" },
            { name: "unknown-finish", assistant: { finish: "unknown", tool: "completed" as const }, outcome: "uncertain" },
            { name: "failed", assistant: { error: apiError() }, outcome: "failed" },
            { name: "unanswered", assistant: false as const, outcome: "unanswered" },
          ]
          for (const item of cases) {
            const session = yield* Session.use.create({ title: item.name })
            const tail = yield* seed(session, item.assistant)
            const before = yield* messages(dir, session.id)
            expect({ name: item.name, ...(yield* nudge(dir, session.id, `req-${item.name}`, tail.id)) }).toEqual({
              name: item.name,
              outcome: item.outcome,
              requestID: `req-${item.name}`,
            })
            expect(yield* messages(dir, session.id)).toEqual(before)
          }
          expect(yield* llm.inputs).toHaveLength(0)
          expect(yield* toolRuns(dir)).toBe("")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a tool error the tool itself returned is a durable result and resumes",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("handled the error")
          const session = yield* Session.use.create({ title: "Tool error" })
          const tail = yield* seed(session, { finish: "tool-calls", tool: "tool-error" })
          expect((yield* nudge(dir, session.id, "req-tool-error", tail.id)).outcome).toBe("started")
          yield* idleWithReply(dir, session.id, "handled the error")
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "pending inputs are handed back unpromoted and a stale observation starts nothing",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "Pending" })
          const tail = yield* seed(session, { finish: "stop", text: "done" })
          // Admitted without a wake, as a queued input left behind by an earlier Stop would be.
          const inputs = yield* SessionInput.Service
          yield* inputs.admit(session.id, { requestID: "queued-1", delivery: "queue", text: "later" })
          expect(yield* nudge(dir, session.id, "req-pending", tail.id)).toEqual({
            outcome: "pending-input",
            requestID: "req-pending",
            requestIDs: ["queued-1"],
          })
          expect(yield* inputs.get(session.id, "queued-1")).toMatchObject({ state: "pending", delivery: "queue" })

          const other = yield* Session.use.create({ title: "Stale" })
          const first = yield* seed(other, { finish: "stop", text: "one" })
          yield* seed(other, { finish: "stop", text: "two" })
          expect(yield* nudge(dir, other.id, "req-stale", first.id)).toEqual({ outcome: "stale", requestID: "req-stale" })
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a busy session is refused and concurrent identical nudges start exactly one turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const held = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
          yield* llm.push(reply().text("only once").wait(held.promise).stop())
          const session = yield* Session.use.create({ title: "Race" })
          const tail = yield* seed(session, { finish: "tool-calls", tool: "completed" })

          const outcomes = yield* Effect.forEach(
            Array.from({ length: 6 }),
            () => nudge(dir, session.id, "req-race", tail.id),
            { concurrency: "unbounded" },
          )
          // Identical requests either win the run or report it; only one provider turn ever starts.
          expect(outcomes.filter((item) => item.outcome === "started").length).toBeGreaterThanOrEqual(1)
          expect(outcomes.every((item) => ["started", "busy"].includes(item.outcome))).toBe(true)
          yield* llm.wait(1)
          expect((yield* nudge(dir, session.id, "req-race", tail.id)).outcome).toBe("started")
          expect((yield* nudge(dir, session.id, "req-other", tail.id)).outcome).toBe("busy")
          held.resolve()
          yield* idleWithReply(dir, session.id, "only once")
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a reused request ID is refused with 409 however far the session has moved on",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("resumed once")
          const session = yield* Session.use.create({ title: "Reuse far" })
          const tail = yield* seed(session, { finish: "tool-calls", tool: "completed" })
          expect((yield* nudge(dir, session.id, "req-far", tail.id)).outcome).toBe("started")
          yield* idleWithReply(dir, session.id, "resumed once")
          // Far more than any recent-message window: the record, not the transcript, holds the identity.
          const newest = yield* Effect.forEach(Array.from({ length: 25 }), () => seed(session, { finish: "tool-calls", tool: "completed" })).pipe(
            Effect.map((items) => items.at(-1)!),
          )
          const reused = yield* post(dir, `/session/${session.id}/nudge`, { requestID: "req-far", observedMessageID: newest.id })
          expect(reused.status).toBe(409)
          expect(yield* llm.inputs).toHaveLength(1)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a refused request keeps its first outcome on an exact retry even after the session becomes nudgeable",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "Refusal replay" })
          const tail = yield* seed(session, { finish: "tool-calls", tool: "completed" })
          const inputs = yield* SessionInput.Service
          yield* inputs.admit(session.id, { requestID: "queued-replay", delivery: "queue", text: "later" })
          const refused = yield* nudge(dir, session.id, "req-replay", tail.id)
          expect(refused).toEqual({ outcome: "pending-input", requestID: "req-replay", requestIDs: ["queued-replay"] })
          yield* inputs.cancel(session.id, "queued-replay")
          expect(yield* nudge(dir, session.id, "req-replay", tail.id)).toEqual(refused)
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "a Nudge input already promoted by another wake is reported as started, not stale",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.use.create({ title: "Promoted elsewhere" })
          const tail = yield* seed(session, { finish: "stop", text: "done" })
          // What a wake from another request leaves when it promotes this request's input before its guard.
          const inputs = yield* SessionInput.Service
          yield* inputs.admit(session.id, {
            requestID: "nudge:req-raced",
            delivery: "steer",
            text: SessionNudge.TEXT,
            source: { type: "editspace-mail", id: "nudge:req-raced", sender: SessionNudge.SENDER, recipient: session.id, kind: SessionNudge.KIND },
          })
          expect(yield* inputs.promote(session.id, false)).toBe(true)
          const receipt = yield* inputs.get(session.id, "nudge:req-raced")
          const messageID = receipt.state === "promoted" ? receipt.messageID : undefined
          expect(yield* nudge(dir, session.id, "req-raced", tail.id)).toEqual({ outcome: "started", requestID: "req-raced", messageID })
          expect(yield* llm.inputs).toHaveLength(0)
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live(
  "peer mail that only carries kind nudge is not auto-acknowledged on presentation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("read the mail")
          const session = yield* Session.use.create({ title: "Peer nudge mail" })
          yield* seed(session, { finish: "stop", text: "done" })
          expect((yield* post(dir, `/session/${session.id}/input`, {
            requestID: "peer-nudge",
            delivery: "steer",
            text: "please continue",
            source: { type: "editspace-mail", id: "peer#1", sender: "peer-lane", recipient: session.id, kind: "nudge" },
          })).status).toBe(200)
          yield* idleWithReply(dir, session.id, "read the mail")
          const receipt = yield* pollWithTimeout(
            requestInDirectory(`/session/${session.id}/input/peer-nudge`, dir).pipe(
              Effect.flatMap((response) => response.json),
              Effect.map((body) => body as { state: string }),
              Effect.map((body) => (body.state === "presented" || body.state === "handled" ? body : undefined)),
            ),
            "peer mail was not presented",
            "20 seconds",
          )
          expect(receipt.state).toBe("presented")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

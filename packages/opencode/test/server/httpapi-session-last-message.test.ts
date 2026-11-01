import { afterEach, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionInput } from "@/session/input"
import { MessageID, PartID } from "@/session/schema"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(SessionInput.node),
    AppNodeBuilder.build(Database.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

type Row = { id: string; lastMessage?: unknown }

// Read through the public list route, as the desktop and Android chat lists do.
const listed = (dir: string, sessionID: string) =>
  requestInDirectory("/experimental/session?roots=true&archived=true&limit=200", dir).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) => (body as Row[]).find((row) => row.id === sessionID)),
  )

const preview = (dir: string, sessionID: string) =>
  listed(dir, sessionID).pipe(Effect.map((row) => row?.lastMessage))

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const userMessage = Effect.fn("test.userMessage")(function* (
  sessionID: Session.Info["id"],
  text: string,
  extra: Partial<SessionV1.User> = {},
) {
  const sessions = yield* Session.Service
  const user: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "build",
    time: { created: Date.now() },
    model,
    ...extra,
  }
  yield* sessions.updateMessage(user)
  const part = yield* sessions.updatePart({ id: PartID.ascending(), sessionID, messageID: user.id, type: "text", text })
  return { user, part }
})

const assistantMessage = Effect.fn("test.assistantMessage")(function* (
  session: Session.Info,
  parentID: SessionV1.User["id"],
  extra: Partial<SessionV1.Assistant> = {},
) {
  const sessions = yield* Session.Service
  const now = Date.now()
  const reply: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID,
    agent: "build",
    mode: "build",
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: now },
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
  }
  yield* sessions.updateMessage(reply)
  return reply
})

const text = (reply: SessionV1.Assistant, value: string, time: SessionV1.TextPart["time"]) =>
  Session.Service.use((sessions) =>
    sessions.updatePart({
      id: PartID.ascending(),
      sessionID: reply.sessionID,
      messageID: reply.id,
      type: "text",
      text: value,
      time,
    }),
  )

it.live("a new session lists no message and advertises the capability", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const session = yield* Session.use.create({ title: "Empty" })
      expect(yield* preview(dir, session.id)).toEqual({ type: "none" })
      const caps = yield* requestInDirectory("/experimental/capabilities", dir).pipe(Effect.flatMap((r) => r.json))
      expect(caps).toMatchObject({ session: { turnTime: true, lastMessage: true } })
    }),
  ),
)

it.live("typed user text is listed as human with its creation time", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const session = yield* Session.use.create({ title: "Typed" })
      const { user } = yield* userMessage(session.id, "  fix the\n\nflaky   test ")
      expect(yield* preview(dir, session.id)).toEqual({
        type: "message",
        id: user.id,
        role: "user",
        source: { type: "human" },
        time: user.time.created,
        excerpt: "fix the flaky test",
        truncated: false,
      })
    }),
  ),
)

it.live("assistant text replaces the preview only once finalized, with its end time", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const session = yield* Session.use.create({ title: "Streaming" })
      const { user } = yield* userMessage(session.id, "question")
      const reply = yield* assistantMessage(session, user.id)
      const streaming = yield* text(reply, "partial ans", { start: Date.now() })
      expect(yield* preview(dir, session.id)).toMatchObject({ id: user.id, role: "user" })

      const end = Date.now() + 5
      yield* Session.Service.use((sessions) =>
        sessions.updatePart({ ...streaming, text: "partial answer, done", time: { start: streaming.time!.start, end } }),
      )
      expect(yield* preview(dir, session.id)).toEqual({
        type: "message",
        id: reply.id,
        role: "assistant",
        source: { type: "agent", agent: "build", providerID: "test", modelID: "test-model" },
        time: end,
        excerpt: "partial answer, done",
        truncated: false,
      })
    }),
  ),
)

it.live("tool, reasoning and synthetic parts newer than the message leave it unchanged", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* Session.use.create({ title: "Tools" })
      const { user } = yield* userMessage(session.id, "run the build")
      const reply = yield* assistantMessage(session, user.id)
      const now = Date.now() + 10
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: reply.id,
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "completed", input: {}, output: "secret-ish output", title: "bash", metadata: {}, time: { start: now, end: now } },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: reply.id,
        type: "reasoning",
        text: "thinking",
        time: { start: now, end: now },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: reply.id,
        type: "text",
        text: "<system-reminder>internal</system-reminder>",
        synthetic: true,
        time: { start: now, end: now },
      })
      yield* text(reply, "   ", { start: now, end: now })
      expect(yield* preview(dir, session.id)).toMatchObject({ id: user.id, excerpt: "run the build" })
    }),
  ),
)

it.live("peer mail and compaction summaries never become the preview", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const session = yield* Session.use.create({ title: "Mail" })
      const { user } = yield* userMessage(session.id, "typed by a human")
      yield* userMessage(session.id, "task from a peer lane", {
        source: { type: "editspace-mail", id: "lane#1", sender: "orchestrator", recipient: "lane", kind: "task" },
      })
      const summary = yield* assistantMessage(session, user.id, { summary: true })
      yield* text(summary, "compacted history", { start: Date.now(), end: Date.now() + 10 })
      expect(yield* preview(dir, session.id)).toMatchObject({ id: user.id, source: { type: "human" } })
    }),
  ),
)

it.live("long text is excerpted to 200 characters and marked truncated", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const session = yield* Session.use.create({ title: "Long" })
      yield* userMessage(session.id, "é".repeat(150) + " " + "x".repeat(150))
      const value = (yield* preview(dir, session.id)) as { excerpt: string; truncated: boolean }
      expect(Array.from(value.excerpt)).toHaveLength(200)
      expect(value.truncated).toBe(true)
    }),
  ),
)

it.live("removing the previewed message or part falls back to the previous real message", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* Session.use.create({ title: "Removal" })
      const first = yield* userMessage(session.id, "first")
      const second = yield* userMessage(session.id, "second")
      expect(yield* preview(dir, session.id)).toMatchObject({ id: second.user.id })

      yield* sessions.removePart({ sessionID: session.id, messageID: second.user.id, partID: second.part.id })
      expect(yield* preview(dir, session.id)).toMatchObject({ id: first.user.id, excerpt: "first" })

      yield* sessions.removeMessage({ sessionID: session.id, messageID: first.user.id })
      expect(yield* preview(dir, session.id)).toEqual({ type: "none" })
    }),
  ),
)

it.live("a staged revert hides the preview until it is cleared", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* Session.use.create({ title: "Revert" })
      yield* userMessage(session.id, "kept")
      const reverted = yield* userMessage(session.id, "reverted text")
      yield* sessions.setRevert({ sessionID: session.id, revert: { messageID: reverted.user.id }, summary: undefined })
      expect(yield* preview(dir, session.id)).toBeUndefined()

      // Parts arriving while the revert is staged do not reveal anything either.
      yield* userMessage(session.id, "during revert")
      expect(yield* preview(dir, session.id)).toBeUndefined()

      yield* sessions.clearRevert(session.id)
      expect(yield* preview(dir, session.id)).toMatchObject({ excerpt: "during revert" })
    }),
  ),
)

it.live("a session from before the upgrade is unknown until its next real message", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const session = yield* Session.use.create({ title: "Old" })
      const { db } = yield* Database.Service
      // Pre-upgrade rows have no projected value.
      yield* db.update(SessionTable).set({ last_message: null }).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
      const before = yield* listed(dir, session.id)
      expect(before).toBeDefined()
      expect(before!.lastMessage).toBeUndefined()

      const { user } = yield* userMessage(session.id, "back again")
      expect(yield* preview(dir, session.id)).toMatchObject({ id: user.id, excerpt: "back again" })
    }),
  ),
)

it.live(
  "a real prompt lists the promoted input, then the finalized reply",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* llm.text("the reply")
          const session = yield* Session.use.create({ title: "Prompt" })
          const response = yield* requestInDirectory(`/session/${session.id}/prompt_async`, dir, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "hello there" }],
            }),
          })
          expect(response.status).toBe(204)
          // Assert only once the session is idle, so the value is the settled one, not a mid-turn snapshot.
          yield* pollWithTimeout(
            requestInDirectory("/session/status", dir).pipe(
              Effect.flatMap((r) => r.json),
              Effect.map((status) => {
                const entry = (status as Record<string, { type: string }>)[session.id]
                return entry && entry.type !== "idle" ? undefined : true
              }),
              Effect.flatMap((idle) =>
                idle
                  ? preview(dir, session.id).pipe(
                      Effect.map((value) => ((value as { role?: string } | undefined)?.role === "assistant" ? value : undefined)),
                    )
                  : Effect.succeed(undefined),
              ),
            ),
            "turn did not settle with the reply listed",
            "45 seconds",
          )
          const settled = yield* preview(dir, session.id)
          expect(settled).toMatchObject({ role: "assistant", excerpt: "the reply", source: { type: "agent" } })
          expect(typeof (settled as { time: number }).time).toBe("number")
        }),
      { config: testProviderConfig },
    ),
  90_000,
)

it.live("credential-shaped text is redacted from the excerpt, ordinary paths and SHAs are kept", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const session = yield* Session.use.create({ title: "Redaction" })
      // Fake, credential-shaped fixtures only.
      yield* userMessage(
        session.id,
        "use sk-test-AAAAAAAAAAAAAAAAAAAA and xoxb-0000000000-fake in packages/core/src/session at 3a32fceda370aaaabbbbccccddddeeeeffff0000",
      )
      expect(yield* preview(dir, session.id)).toMatchObject({
        excerpt: "use [redacted] and [redacted] in packages/core/src/session at 3a32fceda370aaaabbbbccccddddeeeeffff0000",
      })
    }),
  ),
)

it.live("renaming a session keeps its last message", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const session = yield* Session.use.create({ title: "Before" })
      const { user } = yield* userMessage(session.id, "hello")
      yield* Session.Service.use((sessions) => sessions.setTitle({ sessionID: session.id, title: "After" }))
      const row = (yield* listed(dir, session.id)) as Row & { title: string }
      expect(row.title).toBe("After")
      expect(row.lastMessage).toMatchObject({ id: user.id, excerpt: "hello" })
    }),
  ),
)

it.live("a previewed message that gains a mail source or becomes a summary stops being the preview", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* Session.use.create({ title: "Metadata" })
      const first = yield* userMessage(session.id, "typed first")
      const second = yield* userMessage(session.id, "typed second")
      expect(yield* preview(dir, session.id)).toMatchObject({ id: second.user.id })

      yield* sessions.updateMessage({
        ...second.user,
        source: { type: "editspace-mail", id: "lane#2", sender: "orchestrator", recipient: "lane", kind: "task" },
      })
      expect(yield* preview(dir, session.id)).toMatchObject({ id: first.user.id, excerpt: "typed first" })

      const reply = yield* assistantMessage(session, first.user.id)
      yield* text(reply, "an answer", { start: Date.now(), end: Date.now() + 10 })
      expect(yield* preview(dir, session.id)).toMatchObject({ id: reply.id })
      yield* sessions.updateMessage({ ...reply, summary: true })
      expect(yield* preview(dir, session.id)).toMatchObject({ id: first.user.id })
    }),
  ),
)

it.live("a late update of an older message while unknown does not claim to be the latest", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* Session.use.create({ title: "Late" })
      const old = yield* userMessage(session.id, "old message")
      const latest = yield* userMessage(session.id, "latest message")
      const { db } = yield* Database.Service
      yield* db.update(SessionTable).set({ last_message: null }).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)

      yield* sessions.updatePart({ ...old.part, text: "old message, edited late" })
      expect(yield* preview(dir, session.id)).toMatchObject({ id: latest.user.id, excerpt: "latest message" })
    }),
  ),
)

it.live("removal with no qualifying message among the newest 50 becomes unknown, not none", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* Session.use.create({ title: "Window" })
      const old = yield* userMessage(session.id, "outside the window")
      for (const _ of Array.from({ length: 50 })) yield* assistantMessage(session, old.user.id)
      const latest = yield* userMessage(session.id, "newest")
      expect(yield* preview(dir, session.id)).toMatchObject({ id: latest.user.id })

      yield* sessions.removeMessage({ sessionID: session.id, messageID: latest.user.id })
      expect(yield* preview(dir, session.id)).toBeUndefined()
    }),
  ),
)

import { afterEach, expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { disposeAllInstances, withTmpdirInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionSummary.node, Session.node, SessionProjector.node, Snapshot.node, EventV2Bridge.node, FSUtil.node])),
)

afterEach(async () => {
  await disposeAllInstances()
})

const BUDGET = 256 * 1024

/** Enables the operator rollout gate for the duration of `body`. */
const withBudget = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_SUMMARY_PATCH_BUDGET
      process.env.OPENCODE_SUMMARY_PATCH_BUDGET = "1"
      return previous
    }),
    () => body,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_SUMMARY_PATCH_BUDGET
        else process.env.OPENCODE_SUMMARY_PATCH_BUDGET = previous
      }),
  )
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const lines = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag} line ${i}`).join("\n") + "\n"

const write = (file: string, content: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))

/** One user turn whose single step moved the worktree from `from` to `to`, as the processor records it. */
const turn = Effect.fn("test.turn")(function* (from: string, to: string) {
  const sessions = yield* Session.Service
  const dir = (yield* TestInstance).directory
  const session = yield* sessions.create({ title: "summary payload" })
  const user: SessionV1.User = { id: MessageID.ascending(), sessionID: session.id, role: "user", agent: "build", time: { created: Date.now() }, model }
  yield* sessions.updateMessage(user)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "change files" })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now() },
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* sessions.updateMessage(assistant)
  yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: assistant.id, type: "step-start", snapshot: from })
  const finish = (snapshot: string) =>
    sessions.updatePart({
      id: PartID.ascending(),
      sessionID: session.id,
      messageID: assistant.id,
      type: "step-finish",
      reason: "tool-calls",
      snapshot,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  yield* finish(to)
  return { session, user, assistant, finish }
})

const stored = (sessionID: Session.Info["id"], messageID: MessageID) =>
  Session.Service.use((sessions) => sessions.messages({ sessionID })).pipe(
    Effect.map((all) => {
      const info = all.find((m) => m.info.id === messageID)!.info
      return info.role === "user" ? (info.summary?.diffs ?? []) : []
    }),
  )

const inlineBytes = (diffs: readonly Snapshot.FileDiff[]) =>
  diffs.reduce((sum, diff) => sum + Buffer.byteLength(diff.patch ?? ""), 0)

/** Counts message.updated broadcasts and their serialized bytes while `body` runs. */
const broadcasts = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const seen = { count: 0, bytes: 0 }
    const fiber = yield* events.subscribe(SessionV1.Event.MessageUpdated).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          seen.count++
          seen.bytes += JSON.stringify(event).length
        }),
      ),
      Effect.forkChild,
    )
    yield* Effect.sleep("20 millis")
    const value = yield* body
    yield* Effect.sleep("50 millis")
    yield* Fiber.interrupt(fiber)
    return { value, seen }
  })

it.live(
  "a turn changing hundreds of files stores at most 256 KiB of inline patch text and keeps every file's counts",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      for (let i = 0; i < 240; i++) yield* write(`${dir}/src/kept-${i}.ts`, lines(150, `before ${i}`))
      const from = (yield* snapshot.track())!
      for (let i = 0; i < 240; i++) yield* write(`${dir}/src/kept-${i}.ts`, lines(150, `before ${i}`).replace("line 7\n", "line 7 changed\n"))
      for (let i = 0; i < 308; i++) yield* write(`${dir}/src/added-${i}.ts`, lines(140, `added ${i}`))
      const to = (yield* snapshot.track())!
      const t = yield* turn(from, to)
      const full = yield* snapshot.diffFull(from, to)

      yield* SessionSummary.Service.use((summary) => summary.summarize({ sessionID: t.session.id, messageID: t.user.id }))

      const diffs = yield* stored(t.session.id, t.user.id)
      expect(diffs).toHaveLength(548)
      expect(inlineBytes(diffs)).toBeLessThanOrEqual(BUDGET)
      expect(diffs.map((d) => [d.file, d.status, d.additions, d.deletions])).toEqual(
        full.map((d) => [d.file, d.status, d.additions, d.deletions]),
      )
      // Every file either carries its exact patch or says it was omitted; none becomes an empty diff.
      for (const [index, diff] of diffs.entries()) {
        if (diff.patch !== undefined) expect(diff.patch).toBe(full[index]!.patch!)
        if (diff.patch === undefined) expect(diff.patchOmitted).toBe(true)
      }
      expect(diffs.some((d) => d.patchOmitted)).toBe(true)
    }).pipe(withBudget, withTmpdirInstance({ git: true })),
  120_000,
)

it.live(
  "omitted patches are still served in full by the session diff route",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      yield* write(`${dir}/small.ts`, lines(5, "small"))
      const from = (yield* snapshot.track())!
      yield* write(`${dir}/small.ts`, lines(5, "small").replace("line 2", "line 2 edited"))
      yield* write(`${dir}/big.ts`, lines(20_000, "big"))
      const to = (yield* snapshot.track())!
      const t = yield* turn(from, to)
      const full = yield* snapshot.diffFull(from, to)
      const summary = yield* SessionSummary.Service
      yield* summary.summarize({ sessionID: t.session.id, messageID: t.user.id })

      const diffs = yield* stored(t.session.id, t.user.id)
      const big = diffs.find((d) => d.file === "big.ts")!
      expect(big).toMatchObject({ status: "added", additions: 20_000, deletions: 0, patchOmitted: true })
      expect(big.patch).toBeUndefined()
      expect(diffs.find((d) => d.file === "small.ts")!.patch).toBe(full.find((d) => d.file === "small.ts")!.patch!)

      const served = yield* summary.diff({ sessionID: t.session.id, messageID: t.user.id })
      expect(served.map((d) => [d.file, d.patch])).toEqual(full.map((d) => [d.file, d.patch]))
      expect(served.some((d) => d.patchOmitted)).toBe(false)
    }).pipe(withBudget, withTmpdirInstance({ git: true })),
  120_000,
)

it.live(
  "the inline budget counts UTF-8 bytes, not characters",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      const from = (yield* snapshot.track())!
      // About 100k characters each, about 300 KB as UTF-8: one fits by characters but not by bytes.
      for (let i = 0; i < 3; i++) yield* write(`${dir}/wide-${i}.txt`, "é漢".repeat(25_000) + "\n")
      const to = (yield* snapshot.track())!
      const t = yield* turn(from, to)
      yield* SessionSummary.Service.use((summary) => summary.summarize({ sessionID: t.session.id, messageID: t.user.id }))
      const diffs = yield* stored(t.session.id, t.user.id)
      expect(diffs).toHaveLength(3)
      expect(inlineBytes(diffs)).toBeLessThanOrEqual(BUDGET)
      expect(diffs.every((d) => d.patch !== undefined || d.patchOmitted === true)).toBe(true)
    }).pipe(withBudget, withTmpdirInstance({ git: true })),
  120_000,
)

it.live(
  "a small diff is stored exactly as before",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      yield* write(`${dir}/a.ts`, lines(10, "a"))
      const from = (yield* snapshot.track())!
      yield* write(`${dir}/a.ts`, lines(10, "a").replace("line 3", "line three"))
      const to = (yield* snapshot.track())!
      const t = yield* turn(from, to)
      yield* SessionSummary.Service.use((summary) => summary.summarize({ sessionID: t.session.id, messageID: t.user.id }))
      expect(yield* stored(t.session.id, t.user.id)).toEqual(yield* snapshot.diffFull(from, to))
    }).pipe(withTmpdirInstance({ git: true })),
  120_000,
)

it.live(
  "an unchanged turn range is not recomputed or rebroadcast; a range that changes again is",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      const summary = yield* SessionSummary.Service
      yield* write(`${dir}/a.ts`, lines(10, "a"))
      const from = (yield* snapshot.track())!
      yield* write(`${dir}/a.ts`, lines(10, "a").replace("line 3", "line three"))
      const to = (yield* snapshot.track())!
      const t = yield* turn(from, to)
      const input = { sessionID: t.session.id, messageID: t.user.id }
      yield* summary.summarize(input)

      // A later step that changed nothing ends on the same tree.
      yield* t.finish(to)
      const again = yield* broadcasts(summary.summarize(input))
      expect(again.seen.count).toBe(0)

      // The same turn changes the worktree again: the summary follows.
      yield* write(`${dir}/b.ts`, lines(3, "b"))
      const next = (yield* snapshot.track())!
      yield* t.finish(next)
      const changed = yield* broadcasts(summary.summarize(input))
      expect(changed.seen.count).toBe(1)
      expect((yield* stored(t.session.id, t.user.id)).map((d) => d.file)).toEqual(["a.ts", "b.ts"])
    }).pipe(withTmpdirInstance({ git: true })),
  120_000,
)

it.live(
  "concurrent summaries of the same turn range publish one update",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      const summary = yield* SessionSummary.Service
      yield* write(`${dir}/a.ts`, lines(10, "a"))
      const from = (yield* snapshot.track())!
      yield* write(`${dir}/a.ts`, lines(10, "a").replace("line 3", "line three"))
      const to = (yield* snapshot.track())!
      const t = yield* turn(from, to)
      const input = { sessionID: t.session.id, messageID: t.user.id }
      const run = yield* broadcasts(
        Effect.all([summary.summarize(input), summary.summarize(input), summary.summarize(input)], { concurrency: "unbounded" }),
      )
      expect(run.seen.count).toBe(1)
      expect(yield* stored(t.session.id, t.user.id)).toEqual(yield* snapshot.diffFull(from, to))
    }).pipe(withTmpdirInstance({ git: true })),
  120_000,
)

it.live(
  "without the rollout gate every patch stays inline, as older clients expect",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      const from = (yield* snapshot.track())!
      yield* write(`${dir}/big.ts`, lines(20_000, "big"))
      const to = (yield* snapshot.track())!
      const t = yield* turn(from, to)
      yield* SessionSummary.Service.use((summary) => summary.summarize({ sessionID: t.session.id, messageID: t.user.id }))
      const diffs = yield* stored(t.session.id, t.user.id)
      expect(diffs).toEqual(yield* snapshot.diffFull(from, to))
      expect(diffs.some((d) => d.patchOmitted)).toBe(false)
    }).pipe(withTmpdirInstance({ git: true })),
  120_000,
)

it.live(
  "an omitted patch whose turn moved on after summarizing stays omitted in the diff route",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      const summary = yield* SessionSummary.Service
      const from = (yield* snapshot.track())!
      yield* write(`${dir}/big.ts`, lines(20_000, "big"))
      const to = (yield* snapshot.track())!
      const t = yield* turn(from, to)
      yield* summary.summarize({ sessionID: t.session.id, messageID: t.user.id })
      // A later step grows the file, but the summary has not been refreshed yet.
      yield* write(`${dir}/big.ts`, lines(20_001, "big"))
      yield* t.finish((yield* snapshot.track())!)

      const served = yield* summary.diff({ sessionID: t.session.id, messageID: t.user.id })
      expect(served).toEqual([{ file: "big.ts", status: "added", additions: 20_000, deletions: 0, patchOmitted: true }])
    }).pipe(withBudget, withTmpdirInstance({ git: true })),
  120_000,
)

it.live("the rollout gate is off unless OPENCODE_SUMMARY_PATCH_BUDGET names a positive byte count or 1", () =>
  Effect.sync(() => {
    expect(SessionSummary.patchBudget(undefined)).toBeUndefined()
    expect(SessionSummary.patchBudget("")).toBeUndefined()
    expect(SessionSummary.patchBudget("0")).toBeUndefined()
    expect(SessionSummary.patchBudget("abc")).toBeUndefined()
    expect(SessionSummary.patchBudget("1")).toBe(BUDGET)
    expect(SessionSummary.patchBudget("4096")).toBe(4096)
  }),
)

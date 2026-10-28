import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { UsageRollup } from "@opencode-ai/core/usage/rollup"
import { UsageHourlyTable, UsageRollupStateTable } from "@opencode-ai/core/usage/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const HOUR = 3_600_000

const setUp = (sessionID: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID as never, project_id: Project.ID.global, slug: sessionID, directory: "/project", title: "t", version: "t" })
      .run()
  })

const assistant = (sessionID: string, id: string, created: number) =>
  ({
    id,
    sessionID,
    role: "assistant",
    parentID: "msg_parent",
    agent: "build",
    mode: "build",
    providerID: ProviderV2.ID.make("anthropic"),
    modelID: ModelV2.ID.make("opus"),
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created },
  }) as unknown as SessionV1.Info

const step = (sessionID: string, messageID: string, id: string, cost: number, input = 100) =>
  ({
    id,
    sessionID,
    messageID,
    type: "step-finish",
    reason: "stop",
    cost,
    tokens: { input, output: 10, reasoning: 0, cache: { read: 1000, write: 5 } },
  }) as unknown as SessionV1.Part

const hourly = () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db.select().from(UsageHourlyTable).orderBy(asc(UsageHourlyTable.hour)).all()
  })

describe("UsageRollup", () => {
  it.effect("step usage is added, revised and retracted in the hour of its message", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const sessionID = "ses_usage_live"
      const created = Date.now()
      yield* setUp(sessionID)
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: sessionID as never, info: assistant(sessionID, "msg_a", created) })
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: sessionID as never, part: step(sessionID, "msg_a", "prt_1", 0.5), time: created })
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: sessionID as never, part: step(sessionID, "msg_a", "prt_2", 0.25), time: created })
      expect(yield* hourly()).toMatchObject([
        { hour: Math.floor(created / HOUR), provider_id: "anthropic", model_id: "opus", cost: 0.75, tokens_input: 200, tokens_cache_read: 2000 },
      ])

      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: sessionID as never, part: step(sessionID, "msg_a", "prt_2", 0.5, 300), time: created })
      expect((yield* hourly())[0]).toMatchObject({ cost: 1, tokens_input: 400 })

      yield* events.publish(SessionV1.Event.PartRemoved, { sessionID: sessionID as never, messageID: "msg_a" as never, partID: "prt_1" as never })
      expect((yield* hourly())[0]).toMatchObject({ cost: 0.5, tokens_input: 300 })

      yield* events.publish(SessionV1.Event.MessageRemoved, { sessionID: sessionID as never, messageID: "msg_a" as never })
      expect((yield* hourly())[0]).toMatchObject({ cost: 0, tokens_input: 0 })
    }),
  )

  it.effect("replayed events from another host are not counted here", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const created = Date.now()
      yield* setUp("ses_usage_origin")
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: "ses_usage_origin" as never, info: assistant("ses_usage_origin", "msg_origin", created) })
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: "ses_usage_origin" as never, part: step("ses_usage_origin", "msg_origin", "prt_origin", 2), time: created })
      expect((yield* hourly())[0]?.cost).toBe(2)

      // The same session arriving on this host by replay (sync or move) under new identities.
      yield* setUp("ses_usage_copy")
      const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, "ses_usage_origin")).orderBy(asc(EventTable.seq)).all()
      const rename = (text: string) =>
        text.replaceAll("ses_usage_origin", "ses_usage_copy").replaceAll("msg_origin", "msg_copy").replaceAll("prt_origin", "prt_copy")
      yield* events.replayAll(
        rows.map((row) => ({
          id: EventV2.ID.make(rename(row.id) + "x"),
          type: row.type,
          seq: row.seq,
          aggregateID: "ses_usage_copy",
          data: JSON.parse(rename(JSON.stringify(row.data))),
        })),
      )
      expect(yield* db.select({ id: MessageTable.id }).from(MessageTable).where(eq(MessageTable.id, "msg_copy" as never)).get()).toBeDefined()
      expect((yield* hourly())[0]?.cost).toBe(2)
    }),
  )

  // The backfill pauses between chunks on the real clock.
  it.live("messages older than the cutoff are counted once by the backfill, not live", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const sessionID = "ses_usage_old"
      const old = Date.UTC(2026, 0, 2, 3)
      yield* setUp(sessionID)
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: sessionID as never,
        info: { ...assistant(sessionID, "msg_old", old), cost: 1.5, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } } as SessionV1.Info,
      })
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: sessionID as never, part: step(sessionID, "msg_old", "prt_old", 1.5), time: old })
      expect(yield* hourly()).toEqual([])

      expect(yield* UsageRollup.backfill(db, db)).toMatchObject({ rows: 1, skipped: false })
      expect(yield* UsageRollup.backfill(db, db)).toMatchObject({ rows: 0, skipped: true })
      expect(yield* hourly()).toMatchObject([{ hour: Math.floor(old / HOUR), cost: 1.5, tokens_input: 7 }])
      expect((yield* db.select().from(UsageRollupStateTable).get())?.time_backfilled).toBeNumber()
    }),
  )

  // The backfill pauses between chunks on the real clock.
  it.live("the backfill sums an hour split across chunks exactly once", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const sessionID = "ses_usage_chunks"
      const old = Date.UTC(2026, 0, 3, 5)
      yield* setUp(sessionID)
      for (const [index, cost] of [0.5, 1.25, 2].entries())
        yield* events.publish(SessionV1.Event.MessageUpdated, {
          sessionID: sessionID as never,
          info: {
            ...assistant(sessionID, `msg_chunk_${index}`, old + index),
            cost,
            tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          } as SessionV1.Info,
        })

      yield* UsageRollup.backfill(db, db, 1)
      expect(yield* hourly()).toMatchObject([{ hour: Math.floor(old / HOUR), cost: 3.75, tokens_input: 30, tokens_output: 3 }])
    }),
  )

  it.effect("daily totals follow the caller's local day", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.update(UsageRollupStateTable).set({ time_backfilled: 1 }).run()
      const now = Date.UTC(2026, 9, 27, 3, 30)
      // 22:00 UTC on the 26th: the 26th in UTC, the 27th at UTC+3.
      const hour = Date.UTC(2026, 9, 26, 22) / HOUR
      yield* db
        .insert(UsageHourlyTable)
        .values([
          { hour, provider_id: "anthropic", model_id: "opus", cost: 3, tokens_input: 1 },
          { hour: hour - 48, provider_id: "openai", model_id: "gpt", cost: 1, tokens_input: 1 },
        ])
        .run()
      const utc = yield* UsageRollup.daily(db, { days: 7, offsetMinutes: 0, now })
      expect(utc.days.map((day) => [day.day, day.cost])).toEqual([
        ["2026-10-27", 0],
        ["2026-10-26", 3],
        ["2026-10-25", 0],
        ["2026-10-24", 1],
        ["2026-10-23", 0],
        ["2026-10-22", 0],
        ["2026-10-21", 0],
      ])
      const east = yield* UsageRollup.daily(db, { days: 2, offsetMinutes: 180, now })
      expect(east.days.map((day) => [day.day, day.cost])).toEqual([
        ["2026-10-27", 3],
        ["2026-10-26", 0],
      ])
      expect(east).toMatchObject({ estimate: true, offsetMinutes: 180, coverage: { backfilled: true } })
      expect(east.days[0]?.models).toEqual([
        {
          provider: "anthropic",
          model: "opus",
          cost: 3,
          coverage: "priced",
          tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ])
    }),
  )

  it.effect("usage without a known rate is reported as unpriced, never as zero cost", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.update(UsageRollupStateTable).set({ time_backfilled: 1 }).run()
      const now = Date.UTC(2026, 9, 27, 12)
      const hour = Date.UTC(2026, 9, 27, 10) / HOUR
      yield* db
        .insert(UsageHourlyTable)
        .values([
          { hour, provider_id: "gateway", model_id: "priced", cost: 2, tokens_input: 10 },
          { hour, provider_id: "gateway", model_id: "no-card", cost: 0, tokens_input: 500, tokens_output: 50 },
          { hour, provider_id: "gateway", model_id: "aborted", cost: 0 },
          { hour, provider_id: "lmstudio", model_id: "qwen", cost: 0, tokens_input: 900 },
        ])
        .run()
      const [today] = (yield* UsageRollup.daily(db, {
        days: 1,
        offsetMinutes: 0,
        now,
        hasRate: (_provider, model) => model === "priced",
        isLocal: (provider) => provider === "lmstudio",
      })).days
      expect(today).toMatchObject({ complete: true, cost: 2, unpricedModels: 1, unpricedTokens: 550 })
      expect(today?.models.map((model) => [model.model, model.coverage, model.cost])).toEqual([
        ["priced", "priced", 2],
        ["aborted", "no-usage", 0],
        ["qwen", "local", 0],
        ["no-card", "missing-rate", null],
      ])
    }),
  )

  it.effect("days before the live cutoff are unknown until the backfill has run", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const cutoff = Date.UTC(2026, 9, 27, 6)
      yield* db.update(UsageRollupStateTable).set({ cutoff, time_backfilled: null }).run()
      const days = (yield* UsageRollup.daily(db, { days: 2, offsetMinutes: 0, now: Date.UTC(2026, 9, 28, 1) })).days
      expect(days.map((day) => [day.day, day.complete, day.cost])).toEqual([
        ["2026-10-28", true, 0],
        ["2026-10-27", false, null],
      ])
    }),
  )
})

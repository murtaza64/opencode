import { describe, expect, test } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseReader } from "@opencode-ai/core/database/reader"
import { tmpdir } from "./fixture/tmpdir"

const withReader = async <A, E>(
  effect: Effect.Effect<A, E, Database.Service | DatabaseReader.Service>,
  options: { workers?: number } = {},
) => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "reader.sqlite")
  const writer = Database.layerFromPath(filename)
  const layer = Layer.merge(writer, DatabaseReader.layerFromPath({ filename, ...options }).pipe(Layer.provide(writer)))
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(layer), Effect.scoped))
  if (process.env.DEBUG_READER && Exit.isFailure(exit)) console.log(Cause.pretty(exit.cause))
  return exit
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`CREATE TABLE IF NOT EXISTS reader_fixture (id integer primary key, value text not null)`)
  return db
})

describe("DatabaseReader", () => {
  test("sees rows the writer committed before the read", async () => {
    const exit = await withReader(
      Effect.gen(function* () {
        const writer = yield* setup
        const reader = (yield* DatabaseReader.Service).db
        yield* writer.run(sql`INSERT INTO reader_fixture (value) VALUES ('first')`)
        const before = yield* reader.all<{ value: string }>(sql`SELECT value FROM reader_fixture ORDER BY id`)
        yield* writer.run(sql`INSERT INTO reader_fixture (value) VALUES ('second')`)
        const after = yield* reader.all<{ value: string }>(sql`SELECT value FROM reader_fixture ORDER BY id`)
        return { before: before.map((row) => row.value), after: after.map((row) => row.value) }
      }),
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ before: ["first"], after: ["first", "second"] })
  })

  test("rejects writes", async () => {
    const exit = await withReader(
      Effect.gen(function* () {
        yield* setup
        const reader = (yield* DatabaseReader.Service).db
        return yield* reader.run(sql`INSERT INTO reader_fixture (value) VALUES ('nope')`)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toMatch(/readonly|read-only|query_only/i)
  })

  test("refuses to run inside a writer transaction", async () => {
    const exit = await withReader(
      Effect.gen(function* () {
        const writer = yield* setup
        const reader = (yield* DatabaseReader.Service).db
        return yield* writer.transaction(() => reader.all(sql`SELECT 1`))
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.pretty(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toContain("cannot run inside a transaction")
  })

  test("reports SQL errors as failures and keeps serving", async () => {
    const exit = await withReader(
      Effect.gen(function* () {
        yield* setup
        const reader = (yield* DatabaseReader.Service).db
        const missing = yield* reader.all(sql`SELECT * FROM no_such_table`).pipe(Effect.exit)
        const ok = yield* reader.all<{ x: number }>(sql`SELECT 7 AS x`)
        return { failed: Exit.isFailure(missing), ok: ok[0]?.x }
      }),
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ failed: true, ok: 7 })
  })

  test("keeps the caller's event loop free while a slow read runs", async () => {
    const exit = await withReader(
      Effect.gen(function* () {
        yield* setup
        const reader = (yield* DatabaseReader.Service).db
        let ticks = 0
        const timer = setInterval(() => ticks++, 5)
        // ~3e6 recursive rows: hundreds of ms of SQLite work in the worker.
        yield* reader.all(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000000) SELECT count(*) FROM n`)
        clearInterval(timer)
        return ticks
      }),
      { workers: 1 },
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(Exit.isSuccess(exit) ? exit.value : 0).toBeGreaterThan(10)
  })

  test("fails in-flight reads when the layer closes", async () => {
    let pending: Promise<Exit.Exit<unknown, unknown>> | undefined
    const exit = await withReader(
      Effect.gen(function* () {
        yield* setup
        const reader = (yield* DatabaseReader.Service).db
        pending = Effect.runPromiseExit(
          reader.all(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000000) SELECT count(*) FROM n`),
        )
        yield* Effect.sleep("20 millis")
      }),
      { workers: 1 },
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    const inflight = await pending!
    expect(Exit.isFailure(inflight)).toBe(true)
    expect(Cause.pretty(Exit.isFailure(inflight) ? inflight.cause : Cause.empty)).toContain("database reader closed")
  })

  test("a worker whose connection reports a broken file reopens and the read succeeds", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "reader.sqlite")
    const fs = await import("fs/promises")
    const writer = Database.layerFromPath(filename)
    const layer = Layer.merge(writer, DatabaseReader.layerFromPath({ filename, workers: 1 }).pipe(Layer.provide(writer)))
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* setup
        yield* db.run(sql`INSERT INTO reader_fixture (value) VALUES ('kept')`)
        yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
        const reader = (yield* DatabaseReader.Service).db
        expect((yield* reader.all<{ value: string }>(sql`SELECT value FROM reader_fixture`)).map((row) => row.value)).toEqual(["kept"])
        // The worker's open connection keeps the old file, now unreadable; the path holds an intact copy.
        yield* Effect.promise(async () => {
          await fs.copyFile(filename, `${filename}.copy`)
          const handle = await fs.open(filename, "r+")
          await handle.write(Buffer.alloc(16, 0), 0, 16, 0)
          await handle.close()
          await fs.rename(`${filename}.copy`, filename)
        })
        return (yield* reader.all<{ value: string }>(sql`SELECT value FROM reader_fixture`)).map((row) => row.value)
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    if (Exit.isFailure(exit)) console.log(Cause.pretty(exit.cause))
    expect(Exit.isSuccess(exit) && exit.value).toEqual(["kept"])
  })
})

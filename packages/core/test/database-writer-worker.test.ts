import { describe, expect, test } from "bun:test"
import path from "path"
import { Database as Native } from "bun:sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

const withWriter = async <A, E>(effect: Effect.Effect<A, E, Database.Service>, worker = true) => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "writer.sqlite")
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(Database.layerFromPath(filename, { worker })), Effect.scoped),
  )
  const rows = new Native(filename, { readonly: true }).query("SELECT value FROM writer_fixture ORDER BY id").all() as {
    value: string
  }[]
  return { exit, rows: rows.map((row) => row.value) }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`CREATE TABLE IF NOT EXISTS writer_fixture (id integer primary key, value text not null)`)
  return db
})

describe("database writer worker", () => {
  test("commits a transaction atomically and rolls back a failed one", async () => {
    const result = await withWriter(
      Effect.gen(function* () {
        const db = yield* setup
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`INSERT INTO writer_fixture (value) VALUES ('a')`)
            yield* tx.run(sql`INSERT INTO writer_fixture (value) VALUES ('b')`)
          }),
        )
        const failed = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run(sql`INSERT INTO writer_fixture (value) VALUES ('lost')`)
              return yield* Effect.fail("boom")
            }),
          )
          .pipe(Effect.exit)
        return Exit.isFailure(failed)
      }),
    )
    expect(Exit.isSuccess(result.exit) && result.exit.value).toBe(true)
    expect(result.rows).toEqual(["a", "b"])
  })

  test("reads its own uncommitted writes inside a transaction", async () => {
    const result = await withWriter(
      Effect.gen(function* () {
        const db = yield* setup
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`INSERT INTO writer_fixture (value) VALUES ('mine')`)
            return yield* tx.all<{ value: string }>(sql`SELECT value FROM writer_fixture`)
          }),
        )
      }),
    )
    expect(Exit.isSuccess(result.exit) && result.exit.value.map((row) => row.value)).toEqual(["mine"])
  })

  test("keeps concurrent statements out of an open transaction", async () => {
    const result = await withWriter(
      Effect.gen(function* () {
        const db = yield* setup
        yield* Effect.all(
          [
            db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.run(sql`INSERT INTO writer_fixture (value) VALUES ('t1')`)
                yield* Effect.sleep("30 millis")
                yield* tx.run(sql`INSERT INTO writer_fixture (value) VALUES ('t2')`)
                return yield* Effect.fail("rollback")
              }),
            ).pipe(Effect.exit),
            Effect.sleep("5 millis").pipe(Effect.andThen(db.run(sql`INSERT INTO writer_fixture (value) VALUES ('outside')`))),
          ],
          { concurrency: "unbounded" },
        )
      }),
    )
    // the outside write waited for the transaction; the rollback did not take it along
    expect(Exit.isSuccess(result.exit)).toBe(true)
    expect(result.rows).toEqual(["outside"])
  })

  test("leaves the caller's event loop free during a slow statement", async () => {
    let ticks = 0
    const result = await withWriter(
      Effect.gen(function* () {
        yield* setup
        const { db } = yield* Database.Service
        const timer = setInterval(() => ticks++, 5)
        yield* db.all(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000000) SELECT count(*) FROM n`)
        clearInterval(timer)
      }),
    )
    expect(Exit.isSuccess(result.exit)).toBe(true)
    expect(ticks).toBeGreaterThan(10)
  })

  test("finishes posted writes before closing", async () => {
    const result = await withWriter(
      Effect.gen(function* () {
        const db = yield* setup
        for (let i = 0; i < 200; i++) yield* db.run(sql`INSERT INTO writer_fixture (value) VALUES (${String(i)})`)
      }),
    )
    expect(Exit.isSuccess(result.exit)).toBe(true)
    expect(result.rows.length).toBe(200)
  })

  test("in-thread mode behaves the same", async () => {
    const result = await withWriter(
      Effect.gen(function* () {
        const db = yield* setup
        yield* db.transaction((tx) => tx.run(sql`INSERT INTO writer_fixture (value) VALUES ('x')`))
      }),
      false,
    )
    expect(result.rows).toEqual(["x"])
  })
})

export * as DatabaseReader from "./reader"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Context, Deferred, Effect, Layer, Option } from "effect"
import { identity } from "effect/Function"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Database } from "./database"
import { Flag } from "../flag/flag"
import { Diagnostics } from "../diagnostics"
import { makeGlobalNode } from "../effect/app-node"

/**
 * Read-only queries on worker threads.
 *
 * `bun:sqlite` is synchronous, so a cold read on the main connection blocks every HTTP request,
 * SSE stream and runtime fiber until the page reads finish. `Reader` exposes the same Effect-Drizzle
 * API as `Database.Service`, but each statement runs on one of a small pool of Workers holding their
 * own read-only connections. Call sites opt in; the main connection remains the default.
 *
 * - Visibility: every statement starts its own WAL snapshot, so anything the main connection
 *   committed before the statement was posted is visible.
 * - Transactions: unsupported. Reads inside a main-connection transaction must stay on the writer to
 *   see its uncommitted rows, so starting one here dies.
 * - Writes fail with `SQLITE_READONLY`.
 * - A crashed or disposed worker fails its in-flight statements with `SqlError`. An interrupted
 *   statement keeps running in its worker; the result is discarded.
 */
export interface Interface {
  db: Effect.Success<ReturnType<typeof EffectDrizzleSqlite.makeWithDefaults>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/DatabaseReader") {}

export interface Options {
  readonly filename: string
  readonly workers?: number
  /** SQLite `cache_size` per worker connection (negative = KiB). */
  readonly cacheSize?: number
}

type Request = { id: number; sql: string; params: readonly unknown[]; values: boolean; safeIntegers: boolean }
type Response = { id: number; rows: unknown[] } | { id: number; error: { message: string; code?: unknown; errno?: unknown } }
type Pending = { deferred: Deferred.Deferred<unknown[], SqlError>; worker: Slot }
type Slot = { worker: Worker; inflight: number; dead: boolean }

// Runs inside each Worker, loaded from a blob URL as `(${readerWorker})(Database)`. Minifiers rename
// free identifiers, so it may reference only its parameter and worker globals.
function readerWorker(Native: typeof import("bun:sqlite").Database) {
  let db: import("bun:sqlite").Database | undefined
  const scope = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (message: unknown) => void }
  scope.onmessage = (event) => {
    const message = event.data
    if (message.type === "open") {
      db = new Native(message.filename, { readonly: true })
      db.run(`PRAGMA cache_size = ${Number(message.cacheSize)}`)
      db.run("PRAGMA query_only = ON")
      return
    }
    try {
      const statement = db!.query(message.sql)
      // @ts-ignore bun-types missing safeIntegers method
      statement.safeIntegers(message.safeIntegers)
      const rows = message.values ? statement.values(...message.params) : statement.all(...message.params)
      scope.postMessage({ id: message.id, rows: rows ?? [] })
    } catch (cause) {
      const error = cause as { message?: string; code?: unknown; errno?: unknown }
      scope.postMessage({ id: message.id, error: { message: String(error?.message ?? cause), code: error?.code, errno: error?.errno } })
    }
  }
}

export const make = Effect.fn("DatabaseReader.make")(function* (options: Options) {
  // Depending on the writer also guarantees migrations finished before any worker opens the file.
  const writer = yield* Database.Service
  // An in-memory database is private to its connection; workers would open empty ones. Zero
  // workers keeps every read on the writer (kill switch).
  if (options.filename === ":memory:" || options.filename === "" || options.workers === 0)
    return { db: writer.db } satisfies Interface
  const writerTransaction = writer.db.$client.transactionService
  const source = URL.createObjectURL(new Blob([`import { Database } from "bun:sqlite";(${readerWorker.toString()})(Database)`], { type: "text/javascript" }))
  const pending = new Map<number, Pending>()
  const slots: Slot[] = []
  let nextID = 0
  let closed = false

  const fail = (slot: Slot, message: string, retry = false) => {
    slot.dead = true
    for (const [id, entry] of pending) {
      if (entry.worker !== slot) continue
      pending.delete(id)
      Deferred.doneUnsafe(entry.deferred, Effect.fail(readerError(Object.assign(new Error(message), retry ? { retry } : {}))))
    }
  }

  const spawn = (): Slot => {
    const slot: Slot = { worker: new Worker(source), inflight: 0, dead: false }
    slot.worker.onmessage = (event: MessageEvent<Response>) => {
      const entry = pending.get(event.data.id)
      if (!entry) return
      pending.delete(event.data.id)
      slot.inflight--
      if ("error" in event.data && BROKEN.test(String(event.data.error.code ?? ""))) {
        // A long-lived read-only connection can keep failing on a file a fresh connection reads fine. Retire
        // this worker and retry its statements once on a new connection.
        pending.set(event.data.id, entry)
        slot.inflight++
        fail(slot, `database reader connection reported ${event.data.error.code}`, true)
        slot.worker.terminate()
        return
      }
      if ("error" in event.data)
        return Deferred.doneUnsafe(entry.deferred, Effect.fail(readerError(Object.assign(new Error(event.data.error.message), event.data.error))))
      Deferred.doneUnsafe(entry.deferred, Effect.succeed(event.data.rows))
    }
    slot.worker.onerror = () => fail(slot, "database reader worker crashed")
    slot.worker.addEventListener("close", () => fail(slot, "database reader worker exited"))
    slot.worker.postMessage({ type: "open", filename: options.filename, cacheSize: options.cacheSize ?? -65536 })
    return slot
  }

  const size = Math.max(1, options.workers ?? 2)
  for (let i = 0; i < size; i++) slots.push(spawn())

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true
      for (const slot of slots) {
        fail(slot, "database reader closed")
        slot.worker.terminate()
      }
    }),
  )

  const pick = () => {
    slots.forEach((slot, index) => {
      if (slot.dead) slots[index] = spawn()
    })
    return slots.reduce((best, slot) => (slot.inflight < best.inflight ? slot : best))
  }

  const run = (sql: string, params: ReadonlyArray<unknown>, values: boolean): Effect.Effect<Array<any>, SqlError> =>
    attempt(sql, params, values).pipe(
      Effect.catchIf(retryable, (error) =>
        Effect.logWarning("database reader reopened its connection", { reason: error.message }).pipe(
          Effect.andThen(attempt(sql, params, values)),
        ),
      ),
    )

  const attempt = (sql: string, params: ReadonlyArray<unknown>, values: boolean) =>
    Effect.withFiber<Array<any>, SqlError>((fiber) => {
      if (closed) return Effect.fail(readerError(new Error("database reader closed")))
      if (Option.isSome(Context.getOption(fiber.context, writerTransaction)))
        return Effect.die(new Error("DatabaseReader cannot run inside a transaction"))
      const slot = pick()
      const deferred = Deferred.makeUnsafe<unknown[], SqlError>()
      const id = nextID++
      pending.set(id, { deferred, worker: slot })
      slot.inflight++
      slot.worker.postMessage({
        type: "query",
        id,
        sql,
        params,
        values,
        safeIntegers: Context.get(fiber.context, Client.SafeIntegers),
      } satisfies Request & { type: "query" })
      const start = performance.now()
      // Reader time includes waiting behind other statements on the same worker.
      return Deferred.await(deferred).pipe(
        Effect.tap((rows) => Effect.sync(() => Diagnostics.sql("reader", sql, performance.now() - start, rows.length))),
      ) as Effect.Effect<Array<any>, SqlError>
    })

  const connection = identity<Connection>({
    execute: (sql, params, transformRows) =>
      transformRows ? Effect.map(run(sql, params, false), transformRows) : run(sql, params, false),
    executeRaw: (sql, params) => run(sql, params, false),
    executeValues: (sql, params) => run(sql, params, true),
    executeUnprepared(sql, params, transformRows) {
      return this.execute(sql, params, transformRows)
    },
    executeStream: () => Stream.die("executeStream not implemented"),
  })

  const client = yield* Client.make({
    acquirer: Effect.succeed(connection),
    transactionAcquirer: Effect.die(new Error("DatabaseReader does not support transactions")),
    compiler: Statement.makeCompilerSqlite(),
    spanAttributes: [["db.system.name", "sqlite"], ["db.reader", true]],
  }).pipe(Effect.provide(Reactivity.layer))

  const db = yield* EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.provideService(Client.SqlClient, client))
  return { db } satisfies Interface
})

// File-level SQLite failures: the connection, not the statement, is broken.
const BROKEN = /^SQLITE_(NOTADB|CORRUPT|IOERR|CANTOPEN)/

function retryable(error: SqlError) {
  return (error.reason as { cause?: { retry?: boolean } }).cause?.retry === true
}

function readerError(cause: unknown) {
  return new SqlError({ reason: classifySqliteError(cause, { message: "Failed to execute read", operation: "execute" }) })
}

export const layerFromPath = (options: Options) => Layer.effect(Service, make(options))

export const node = makeGlobalNode({
  service: Service,
  layer: layerFromPath({
    filename: Database.path(),
    workers: Flag.OPENCODE_DB_READER_WORKERS === undefined ? undefined : Number(Flag.OPENCODE_DB_READER_WORKERS),
  }),
  deps: [Database.node],
})

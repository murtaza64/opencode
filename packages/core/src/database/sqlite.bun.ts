import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"
import { Diagnostics } from "../diagnostics"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@opencode-ai/core/database/SqliteBun" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  /** Run every statement on a dedicated Worker connection instead of the calling thread. */
  readonly worker?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

// Runs inside the writer Worker, loaded from a blob URL as `(${writerWorker})(Database)`. Minifiers rename
// free identifiers, so it may reference only its parameter and worker globals. Messages are handled in
// arrival order on one connection, which preserves the caller-side statement and transaction order.
function writerWorker(Native: typeof import("bun:sqlite").Database) {
  let db: import("bun:sqlite").Database | undefined
  const scope = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (message: unknown) => void }
  scope.onmessage = (event) => {
    const message = event.data
    if (message.type === "open") {
      db = new Native(message.filename, { readwrite: true, create: true })
      if (!message.disableWAL) db.run("PRAGMA journal_mode = WAL;")
      return
    }
    if (message.type === "close") {
      db?.close()
      db = undefined
      scope.postMessage({ type: "closed" })
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

type WorkerReply =
  | { id: number; rows: unknown[] }
  | { id: number; error: { message: string; code?: unknown; errno?: unknown } }
  | { type: "closed" }

/**
 * One Worker owning the writer connection. A crashed worker fails its in-flight statements; the next
 * statement starts a fresh worker (SQLite rolls back a transaction left open by the lost connection).
 */
const makeWorkerConnection = (options: Config) =>
  Effect.gen(function* () {
    const source = URL.createObjectURL(
      new Blob([`import { Database } from "bun:sqlite";(${writerWorker.toString()})(Database)`], { type: "text/javascript" }),
    )
    const pending = new Map<number, Deferred.Deferred<unknown[], SqlError>>()
    let nextID = 0
    let closed = false
    let worker: Worker | undefined
    let onClosed: (() => void) | undefined
    const failAll = (message: string) => {
      for (const [id, deferred] of pending) {
        pending.delete(id)
        Deferred.doneUnsafe(deferred, Effect.fail(workerError(new Error(message))))
      }
    }
    const spawn = () => {
      const next = new Worker(source)
      next.onmessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data
        if ("type" in reply) return onClosed?.()
        const deferred = pending.get(reply.id)
        if (!deferred) return
        pending.delete(reply.id)
        if ("error" in reply)
          return Deferred.doneUnsafe(deferred, Effect.fail(workerError(Object.assign(new Error(reply.error.message), reply.error))))
        Deferred.doneUnsafe(deferred, Effect.succeed(reply.rows))
      }
      const lost = (message: string) => () => {
        if (worker === next) worker = undefined
        failAll(message)
      }
      next.onerror = lost("database writer worker crashed")
      next.addEventListener("close", lost("database writer worker exited"))
      next.postMessage({ type: "open", filename: options.filename, disableWAL: options.disableWAL === true })
      return next
    }
    worker = spawn()
    yield* Effect.addFinalizer(() =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            closed = true
            const current = worker
            if (!current) return resolve()
            const done = () => {
              current.terminate()
              failAll("database writer closed")
              resolve()
            }
            // Statements already posted run before "close"; bound the wait so shutdown cannot hang.
            const timer = setTimeout(done, 5_000)
            onClosed = () => {
              clearTimeout(timer)
              done()
            }
            current.postMessage({ type: "close" })
          }),
      ),
    )
    return (query: string, params: ReadonlyArray<unknown>, values: boolean, safeIntegers: boolean) =>
      Effect.suspend(() => {
        if (closed) return Effect.fail(workerError(new Error("database writer closed")))
        worker ??= spawn()
        const deferred = Deferred.makeUnsafe<unknown[], SqlError>()
        const id = nextID++
        pending.set(id, deferred)
        worker.postMessage({ type: "query", id, sql: query, params, values, safeIntegers })
        return Deferred.await(deferred)
      })
  })

function workerError(cause: unknown) {
  return new SqlError({ reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }) })
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database
    const remote = options.worker && options.filename !== ":memory:" ? yield* makeWorkerConnection(options) : undefined

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        if (remote)
          return remote(query, params, false, Context.get(fiber.context, Client.SafeIntegers)) as Effect.Effect<
            Array<Record<string, unknown>>,
            SqlError
          >
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          const start = performance.now()
          const rows = (statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>
          Diagnostics.sql("writer", query, performance.now() - start, rows.length)
          return Effect.succeed(rows)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        if (remote)
          return remote(query, params, true, Context.get(fiber.context, Client.SafeIntegers)) as Effect.Effect<
            Array<unknown[]>,
            SqlError
          >
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          const start = performance.now()
          const rows = (statement.values(...(params as any)) ?? []) as Array<unknown[]>
          Diagnostics.sql("writer", query, performance.now() - start, rows.length)
          return Effect.succeed(rows)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      export: Effect.try({
        try: () => native.serialize(),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
          }),
      }),
      loadExtension: (path) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
        connection,
      )
    })

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        readwrite: config.readwrite ?? true,
        create: config.create ?? true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true) native.run("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as Database })
  }),
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}

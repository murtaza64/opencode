# Off-loop DB reads and failure-state-on-write (design + proof plan)

Context: `runtime-lag/RESEARCH.md`. The live daemon stalled up to 9.4 s with its main thread
100% in `sqlite3_step → pread`; the heaviest polled read is `SessionFailure.list`
(2,677 page misses/call). Two independent changes; either helps, both together are the target.

## A. `Database.Reader`: read-only queries on a worker connection

### Seam

- New service `Database.Reader` in `packages/core/src/database/reader.ts`, same shape as
  `Database.Service` (`{ db }`, the Effect-Drizzle API). Its `SqlClient` connection forwards
  `execute`/`executeValues` to a small pool of Bun Workers (`reader-worker.ts`), each holding
  its own `bun:sqlite` connection opened `readonly: true`.
- Opt-in per call site. No automatic routing: the main connection stays the default for every
  query. First adopters, all read-only HTTP handlers:
  - `GET /experimental/session/failed` (`SessionFailure.list`) — provide `Database.Reader`'s db
    as `Database.Service` at the handler (`handlers/experimental.ts:175` already does
    `provideService(Database.Service, …)`).
  - Message pages / full history GETs (`MessageV2.page`/`hydrate`), session list routes.
- The worker connection is read-only, so an adopted path that turns out to write fails loudly
  (`SQLITE_READONLY`) instead of silently racing the writer.

### Semantics

| Concern | Rule |
|---|---|
| Visibility | WAL: each reader statement starts its own read snapshot. Anything the main connection committed before the read was posted is visible (writes are synchronous on main, so "write Effect completed" ⇒ committed). |
| Read-your-writes inside a transaction | Not supported. `Reader` refuses (`die`) when called with an active `transactionService` in context; those reads stay on the writer, which sees its own uncommitted rows. |
| Multi-statement consistency | Same as today: separate autocommit statements (today other fibers can interleave between statements too). Reader transactions are out of scope for v1. |
| Long readers vs checkpoints | A reader holds its snapshot only for one statement. PASSIVE checkpoints proceed around it; WAL may grow during long reads, bounded by statement time. |
| Errors | Worker classifies SQLite errors and returns `{ code, message }`; main rebuilds `SqlError` via `classifySqliteError`. |
| Worker crash / exit | All in-flight requests on that worker fail with `SqlError` (connection lost); worker is replaced lazily on next request. |
| Interruption | The fiber is released immediately; the worker cannot abort a running `bun:sqlite` statement, so its result is discarded on arrival. Pool concurrency bounds wasted work. |
| Disposal | Layer finalizer stops admission, fails in-flight with `SqlError`, terminates workers, awaits exit (bounded). |
| Startup | `Reader` depends on `Database.Service`, so migrations finish before any worker opens the file. |
| Values | `safeIntegers` flag and params (incl. `Uint8Array`, `bigint`) cross by structured clone; rows return as plain objects. Result cloning runs on main at receive — cost proportional to result bytes, not to I/O; measured in the proof. |
| Resources | Pool size 2, `cache_size` 64 MB per worker (main keeps 512 MB). Bounded queue per worker. |
| Packaging | Worker entry added to `script/build.ts` entrypoints like `src/cli/tui/worker.ts` (`OPENCODE_DB_READER_PATH` define). |

### Not chosen

- Moving *all* DB access off-thread (async writer): changes every write's ordering and
  transaction story; not needed — samples show reads, not writes, block.
- Storage split (separate history DB): no evidence writes or file size alone are the
  bottleneck once reads leave the loop. Revisit if main-thread samples show write latency.
- `cache_size` tuning only: macOS purgeable page cache is reclaimed under host pressure.

## B. Failure state maintained on write

- Column `session.failed_message_id text` (nullable) + partial index
  `session_failed_idx ON session(failed_message_id) WHERE failed_message_id IS NOT NULL`.
- Projector (`core/src/session/projector.ts`, `MessageUpdated` at :264, `MessageRemoved` at ~:600):
  - upsert of a failed assistant row (role assistant, `error.name` set, not
    `MessageAbortedError`) ⇒ `failed_message_id = id`;
  - upsert of a non-failed row with `id > failed_message_id` (IDs ascend with creation)
    or equal id now non-failed ⇒ `NULL`;
  - removal of `failed_message_id` ⇒ recompute from that session's newest row (one indexed lookup).
- The column only has to be a **superset** of true failures. `SessionFailure.list` keeps its
  current per-candidate verification (`MessageV2.page(limit 1)` + `lastInserted`), so a stale
  non-null value is filtered, never shown.
- `list()` candidates: `failed_message_id IS NOT NULL` + existing root/archived/revert/supersession
  filters → O(failed sessions) pages.
- Migration backfills with the current correlated query once (~2.7 K pages on today's DB).
- Writers outside the projector (`cli/cmd/import.ts:200`) set the column the same way or
  leave it for backfill on next start.

## Proof plan (private only; no live rollout, no Core restart)

1. **Bench (done):** same query in-thread vs Worker on a clone: 700–819 ms → ≤22 ms loop lag
   (`runtime-lag/evidence/offthread-bench.ts`).
2. **Prototype** A (Reader + failed handler + message page handler) and B (column, projector,
   backfill, list) in this workspace; unit tests on a temp DB:
   - Reader: visibility after main commit; refuses inside a transaction; readonly write fails;
     worker crash fails in-flight and recovers; disposal fails in-flight and exits workers.
   - Failure column: differential test — for fixture histories (failed step, retry, abort,
     removal, out-of-order time) new `list()` equals old `list()`.
3. **Integration proof** with the real runtime boundary: build the daemon binary from the
   prototype; run baseline (`1b948b69`) and prototype on APFS clones of the live DB, spare
   ports, private HOME, no credentials. Replay slow reads: loop of
   `/experimental/session/failed` + full-history GETs with a small worker/main cache to keep
   reads cold. Measure concurrently:
   - `/global/health` p50/p99/max (5 Hz);
   - admission: `POST /session/:id/input` (`delivery: queue`) on a private session whose model
     points at a local fake provider — time to receipt;
   - SSE: a `/global/event` subscriber's `server.heartbeat` lateness (gap minus the 10 s tick).
   Pass: prototype max health/admission latency and heartbeat lateness < 250 ms while the same
   replay drives the baseline into ≥1 s stalls.
4. Differential check B on the clone: old vs new `list()` identical; page misses 2,677 → tens.

Deliverable: patch stack + evidence; rollout stays with es-app lead / serving-modes.

## Proof results (2026-10-22, private, host load avg 60–73)

Prototype: change `xwutm` (Reader + adoption) on dev `b90058eb`; proof-only slow-read injection in
`vyuvs` (not for landing). Binary sha256 `049202ba…`. Harness: `runtime-lag/evidence/proof/`
(`proof.sh`, `probe.py`); raw lines in `ab-runs.jsonl`. Each run: fresh APFS clone of the live DB,
spare port, private HOME/XDG, `env -i`, `enabled_providers: []`; listener/PID/DB identity asserted.

Unit (`packages/core/test/database-reader.test.ts`, 6 pass): committed rows visible; writes fail
readonly; refused inside a writer transaction; SQL errors fail and the pool keeps serving; caller's
event loop ticks during a slow read; layer close fails in-flight reads.

Integration, replay = 2 loops of `/experimental/session/failed` whose read path includes ~3 M-row
SQLite work on the same connection (models a multi-second cold read inside `sqlite3_step`), 60 s:

| Mode | health p50 / max | admission p50 / max | SSE heartbeat lateness max |
|---|---|---|---|
| reads on main (`WORKERS=0`), run 1 | 1,850 ms / 30,245 ms | 17,356 ms / 28,872 ms | 9,312 ms |
| reads on main, run 2 | 1,673 ms / 26,260 ms | 60,055 ms (timeout) | no heartbeat delivered |
| Reader (`WORKERS=2`), run 1 | 2 ms / 437 ms | 68 ms / 933 ms | 18 ms |
| Reader, run 2 | 2 ms / 432 ms | 79 ms / 985 ms | 22 ms |
| Reader, no slow reads (noise floor) | 3 ms / 749 ms | 57 ms / 1,419 ms | 32 ms |

Reader mode with multi-second reads matches the no-slow-read floor, so the remaining sub-second
outliers belong to the host and to admission's own write/runner work, not to the adopted reads.
The < 250 ms max target is not met by the floor itself on this host.

Second finding: a replay of message-page walkers (80-message pages over 600 sessions) left the
main thread 40–96% busy in JS in both modes (`sqlite_step` 2–3%) — per-request decode/encode of
large pages is main-thread CPU the Reader does not move. Follow-up: run the whole read handler
(query + hydrate + JSON encode) in the worker and return bytes, or cap page payloads.

Failure column (B), read side on a clone (`evidence/proof/failure-column*.sql`): same 4 failed
sessions as the current query; candidate query 225 page misses vs 2,686. Backfill (add column +
correlated update + partial index) took 32 s on the 21.8 GB clone under host load — run it as a
batched background backfill with the old scan as fallback until complete, not as a blocking
startup migration. Projector maintenance and differential tests on fixture histories remain to
be written.

export * as Diagnostics from "./diagnostics"

import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { Global } from "./global"
import { InstallationVersion } from "./installation/version"

/**
 * Process-wide, bounded performance diagnostics for the serving daemon.
 *
 * `start()` (called by `serve`) enables cheap always-on aggregates: event-loop delay and stalls, process
 * CPU/memory, HTTP handler latency with in-flight age, and SQL statement timing on the main writer
 * connection and reader workers. Until `start()` every recorder is a no-op, so CLI processes pay nothing.
 *
 * Nothing here retains request bodies, SQL parameters or literals: statements are keyed by their text with
 * quoted strings and numbers replaced, routes by their path with identifier-like segments replaced. Every
 * table is capped; overflow folds into an "(other)" row.
 *
 * `profile()` captures one CPU profile at a time through the runtime inspector (no listening inspector
 * port), with a duration cap, a size cap and a fixed retention of recent files.
 */

const WINDOW_MS = 10_000
const WINDOWS = 60
const STALLS = 20
const MAX_KEYS = 200
const SLOW_MS = 250
const STALL_MS = 1_000
const BUCKETS = [10, 50, 250, 1_000, 5_000] as const
export const PROFILE_MIN_SECONDS = 1
export const PROFILE_MAX_SECONDS = 120
const PROFILE_MAX_BYTES = 64 * 1024 * 1024
const PROFILE_KEEP = 5
const TICK_MS = 50
const TICK_STALL_MS = 100
const SLOW_REQUEST_MS = 500
const RECENT_ENDED = 50
const LOG_MAX_BYTES = 5 * 1024 * 1024
const LOG_FLUSH_MS = 2_000
const LOG_MAX_PENDING = 1_000
const SLOW_KEEP = 100

type Stat = { n: number; totalMs: number; maxMs: number; rows: number; buckets: number[] }
type Window = {
  at: string
  loopMaxMs: number
  loopP99Ms: number
  cpuUserMs: number
  cpuSystemMs: number
  rssMB: number
  heapMB: number
  requests: number
  requestMaxMs: number
  sqlMs: number
  inflight: number
}

const state = {
  started: undefined as number | undefined,
  timer: undefined as Timer | undefined,
  loop: undefined as ReturnType<typeof monitorEventLoopDelay> | undefined,
  windows: [] as Window[],
  stalls: [] as { at: string; ms: number; routes?: string[] }[],
  slowWindows: 0,
  stallWindows: 0,
  routes: new Map<string, Stat>(),
  sql: new Map<string, Stat>(),
  transactions: newStat(),
  inflight: new Map<number, { label: string; start: number; method: string; directory?: string }>(),
  ended: [] as { label: string; start: number; end: number }[],
  slow: [] as Record<string, unknown>[],
  ticker: undefined as Timer | undefined,
  flusher: undefined as Timer | undefined,
  lastTick: 0,
  pending: [] as string[],
  minute: { p99: 0, max: 0, stalls: 0, windows: 0 },
  nextRequest: 0,
  window: { requests: 0, requestMaxMs: 0, sqlMs: 0 },
  cpu: process.cpuUsage(),
  transactionStart: undefined as number | undefined,
  keys: new Map<string, string>(),
  profiling: false,
}

/** Enables collection. Idempotent; `OPENCODE_DIAGNOSTICS=0` keeps every recorder off. */
export function start() {
  if (state.started !== undefined || process.env.OPENCODE_DIAGNOSTICS === "0") return
  state.started = Date.now()
  state.cpu = process.cpuUsage()
  state.loop = monitorEventLoopDelay({ resolution: 20 })
  state.loop.enable()
  state.timer = setInterval(roll, WINDOW_MS)
  state.timer.unref?.()
  // A 50 ms ticker attributes each block of the loop >= 100 ms to the requests running when it happened.
  state.lastTick = performance.now()
  state.ticker = setInterval(tick, TICK_MS)
  state.ticker.unref?.()
  state.flusher = setInterval(() => void flush(), LOG_FLUSH_MS)
  state.flusher.unref?.()
}

/** Disables collection and drops everything collected (tests). */
export function stop() {
  if (state.timer) clearInterval(state.timer)
  if (state.ticker) clearInterval(state.ticker)
  if (state.flusher) clearInterval(state.flusher)
  state.loop?.disable()
  Object.assign(state, {
    started: undefined,
    timer: undefined,
    loop: undefined,
    windows: [],
    stalls: [],
    slowWindows: 0,
    stallWindows: 0,
    routes: new Map(),
    sql: new Map(),
    transactions: newStat(),
    inflight: new Map(),
    ended: [],
    slow: [],
    ticker: undefined,
    flusher: undefined,
    pending: [],
    minute: { p99: 0, max: 0, stalls: 0, windows: 0 },
    window: { requests: 0, requestMaxMs: 0, sqlMs: 0 },
    transactionStart: undefined,
    keys: new Map(),
  })
}

export function enabled() {
  return state.started !== undefined
}

/** Marks an HTTP request as in flight; pass the result to `requestEnd`. Undefined when disabled. */
export function requestStart(pathname: string, method = "GET", directory?: string) {
  if (state.started === undefined) return undefined
  const id = state.nextRequest++
  state.inflight.set(id, { label: route(pathname), start: performance.now(), method, directory })
  return id
}

/** Ends a request; requests slower than 500 ms are kept (last 100) and appended to the local log. */
export function requestEnd(id: number | undefined, response: { status?: number; bytes?: number } = {}) {
  if (id === undefined) return
  const entry = state.inflight.get(id)
  if (!entry) return
  state.inflight.delete(id)
  const end = performance.now()
  const ms = end - entry.start
  add(state.routes, entry.label, ms, 0)
  state.window.requests++
  state.window.requestMaxMs = Math.max(state.window.requestMaxMs, ms)
  state.ended.push({ label: entry.label, start: entry.start, end })
  if (state.ended.length > RECENT_ENDED) state.ended.shift()
  if (ms < SLOW_REQUEST_MS) return
  const record = {
    type: "slow-request",
    at: new Date().toISOString(),
    method: entry.method,
    route: entry.label,
    ms: Math.round(ms),
    status: response.status,
    bytes: response.bytes,
    directory: entry.directory,
  }
  state.slow.push(record)
  if (state.slow.length > SLOW_KEEP) state.slow.shift()
  log(record)
}

/** Recent slow requests and loop stalls (newest last), as kept in memory. */
export function recent() {
  return { slowRequests: state.slow, stalls: state.stalls, logFile: logFile() }
}

/** Records one SQL statement. `source` distinguishes the main connection from reader workers. */
export function sql(source: "writer" | "reader", text: string, ms: number, rows: number) {
  if (state.started === undefined) return
  add(state.sql, `${source} ${statementKey(text)}`, ms, rows)
  if (source !== "writer") return
  state.window.sqlMs += ms
  const head = text.trimStart().slice(0, 9).toLowerCase()
  if (head.startsWith("begin")) state.transactionStart = performance.now() - ms
  if ((head.startsWith("commit") || head.startsWith("rollback") || head.startsWith("end")) && state.transactionStart !== undefined) {
    record(state.transactions, performance.now() - state.transactionStart, 0)
    state.transactionStart = undefined
  }
}

/** A JSON-safe snapshot of every aggregate plus build and process metadata. */
export function snapshot() {
  const now = performance.now()
  const inflight = [...state.inflight.values()]
  const memory = process.memoryUsage()
  return {
    meta: meta(),
    enabled: state.started !== undefined,
    startedAt: state.started === undefined ? undefined : new Date(state.started).toISOString(),
    windowSeconds: WINDOW_MS / 1000,
    process: {
      rssMB: mb(memory.rss),
      heapUsedMB: mb(memory.heapUsed),
      heapTotalMB: mb(memory.heapTotal),
      externalMB: mb(memory.external),
      cpu: process.cpuUsage(),
      uptimeSeconds: Math.round(process.uptime()),
      // Bun exposes no GC event stream; heap size and extra (native) memory stand in for GC pressure.
      gc: "unsupported",
    },
    loop: {
      current: loopSummary(),
      slowWindows: state.slowWindows,
      stallWindows: state.stallWindows,
      thresholds: { slowMs: SLOW_MS, stallMs: STALL_MS },
      recentStalls: state.stalls,
    },
    requests: {
      inflight: inflight.length,
      oldestInflightMs: inflight.length ? Math.round(now - Math.min(...inflight.map((item) => item.start))) : 0,
      oldestInflight: inflight
        .toSorted((a, b) => a.start - b.start)
        .slice(0, 5)
        .map((item) => ({ route: item.label, ageMs: Math.round(now - item.start) })),
      routes: table(state.routes, 30),
    },
    sql: {
      transactions: summary(state.transactions),
      statements: table(state.sql, 40),
    },
    windows: state.windows,
    profiling: state.profiling,
  }
}

export type ProfileResult = {
  file: string
  bytes: number
  seconds: number
  meta: ReturnType<typeof meta>
  summary: ReturnType<typeof summarize>
}

export class ProfileBusy extends Error {}

/**
 * Captures a CPU profile of this process for `seconds` (clamped to 1..120) at 1 ms sampling, writes it under
 * the log directory and keeps only the newest five. One capture at a time; a concurrent call throws
 * `ProfileBusy`.
 */
export async function profile(input: { seconds: number; label?: string }): Promise<ProfileResult> {
  if (state.profiling) throw new ProfileBusy("a CPU profile is already being captured")
  state.profiling = true
  const seconds = Math.min(PROFILE_MAX_SECONDS, Math.max(PROFILE_MIN_SECONDS, Math.round(input.seconds)))
  const { Session } = await import("node:inspector")
  const session = new Session()
  try {
    session.connect()
    const post = (method: string, params?: object) =>
      new Promise<any>((resolve, reject) =>
        session.post(method, params ?? {}, (error: Error | null, result: unknown) => (error ? reject(error) : resolve(result))),
      )
    await post("Profiler.enable")
    await post("Profiler.setSamplingInterval", { interval: 1000 })
    await post("Profiler.start")
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    const result = await post("Profiler.stop")
    const body = JSON.stringify(result.profile)
    if (body.length > PROFILE_MAX_BYTES) throw new Error(`profile exceeds ${PROFILE_MAX_BYTES} bytes; use a shorter capture`)
    const dir = path.join(Global.Path.log, "profiles")
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const label = (input.label ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)
    const file = path.join(
      dir,
      `cpu-${new Date().toISOString().replace(/[:.]/g, "")}-${process.pid}${label ? `-${label}` : ""}.cpuprofile`,
    )
    await fs.writeFile(file, body, { mode: 0o600 })
    await prune(dir)
    return { file, bytes: body.length, seconds, meta: meta(), summary: summarize(result.profile) }
  } finally {
    session.disconnect()
    state.profiling = false
  }
}

/** Self/inclusive time by function name and file basename; no arguments or values are present in profiles. */
export function summarize(profile: {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[]
  samples: number[]
  startTime?: number
  endTime?: number
}) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map(profile.nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id] as const)))
  const label = (id: number) => {
    const frame = nodes.get(id)!.callFrame
    return `${frame.functionName || "(anonymous)"} ${path.basename(frame.url || "")}:${frame.lineNumber + 1}`
  }
  const self = new Map<string, number>()
  const inclusive = new Map<string, number>()
  let idle = 0
  let gc = 0
  for (const sample of profile.samples) {
    const name = nodes.get(sample)?.callFrame.functionName
    if (name === "(idle)" || name === "(program)") idle++
    if (name === "(garbage collector)") gc++
    const own = label(sample)
    self.set(own, (self.get(own) ?? 0) + 1)
    const seen = new Set<string>()
    for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
      const key = label(id)
      if (seen.has(key) || !parent.has(id)) continue
      seen.add(key)
      inclusive.set(key, (inclusive.get(key) ?? 0) + 1)
    }
  }
  const total = profile.samples.length || 1
  // Bun records no "(idle)" frames: an idle thread takes no samples. Busy share = samples x 1 ms / duration.
  const durationMs = profile.endTime && profile.startTime ? (profile.endTime - profile.startTime) / 1000 : 0
  const busy = durationMs ? Math.min(100, Math.round((profile.samples.length / durationMs) * 1000) / 10) : undefined
  const top = (map: Map<string, number>) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([frame, count]) => ({ frame, percent: Math.round((count / total) * 1000) / 10 }))
  return {
    samples: profile.samples.length,
    busyPercent: busy ?? Math.round(((total - idle) / total) * 1000) / 10,
    gcPercent: Math.round((gc / total) * 1000) / 10,
    self: top(self),
    inclusive: top(inclusive),
  }
}

/** Constant-time check of a diagnostics token against the local token file. */
export async function authorized(token: string | null | undefined) {
  if (!token) return false
  const expected = Buffer.from(await localToken())
  const actual = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * The local diagnostics capability: a random token in a 0600 file under the state directory. Reading it
 * requires the daemon user's filesystem access, so a proxy that forwards HTTP cannot grant diagnostics.
 */
export async function localToken() {
  const file = path.join(Global.Path.state, "diagnostics-token")
  const existing = await fs.readFile(file, "utf8").catch(() => "")
  if (existing.trim()) return existing.trim()
  const token = randomBytes(24).toString("base64url")
  await fs.writeFile(file, token, { mode: 0o600, flag: "wx" }).catch(() => {})
  return (await fs.readFile(file, "utf8")).trim()
}

export const TOKEN_HEADER = "x-opencode-diagnostics-token"

function meta() {
  return {
    version: InstallationVersion,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`,
    at: new Date().toISOString(),
  }
}

function roll() {
  const loop = loopSummary()
  state.loop?.reset()
  const cpu = process.cpuUsage(state.cpu)
  state.cpu = process.cpuUsage()
  const memory = process.memoryUsage()
  const at = new Date().toISOString()
  if (loop.maxMs >= SLOW_MS) state.slowWindows++
  if (loop.maxMs >= STALL_MS) state.stallWindows++
  state.minute.p99 = Math.max(state.minute.p99, loop.p99Ms)
  state.minute.max = Math.max(state.minute.max, loop.maxMs)
  if (++state.minute.windows === 6) {
    log({ type: "loop", at, p99Ms: state.minute.p99, maxMs: state.minute.max, stalls: state.minute.stalls, rssMB: mb(memory.rss) })
    state.minute = { p99: 0, max: 0, stalls: 0, windows: 0 }
  }
  state.windows.push({
    at,
    loopMaxMs: loop.maxMs,
    loopP99Ms: loop.p99Ms,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    rssMB: mb(memory.rss),
    heapMB: mb(memory.heapUsed),
    requests: state.window.requests,
    requestMaxMs: Math.round(state.window.requestMaxMs),
    sqlMs: Math.round(state.window.sqlMs),
    inflight: state.inflight.size,
  })
  if (state.windows.length > WINDOWS) state.windows.shift()
  state.window = { requests: 0, requestMaxMs: 0, sqlMs: 0 }
}

function tick() {
  const now = performance.now()
  const blocked = now - state.lastTick - TICK_MS
  state.lastTick = now
  if (blocked < TICK_STALL_MS) return
  const since = now - blocked - TICK_MS
  const routes = [
    ...[...state.inflight.values()].filter((item) => item.start <= now).map((item) => item.label),
    ...state.ended.filter((item) => item.end >= since).map((item) => item.label),
  ]
  const record = { at: new Date().toISOString(), ms: Math.round(blocked), routes: [...new Set(routes)].slice(0, 5) }
  state.stalls.push(record)
  if (state.stalls.length > STALLS) state.stalls.shift()
  state.minute.stalls++
  log({ type: "stall", ...record })
}

/** Appends to the local JSONL in batches; bounded queue, one rotated file of 5 MB. */
function log(record: Record<string, unknown>) {
  if (state.pending.length < LOG_MAX_PENDING) state.pending.push(JSON.stringify(record))
}

function logFile() {
  return path.join(Global.Path.log, "diagnostics.jsonl")
}

async function flush() {
  if (state.pending.length === 0) return
  const lines = state.pending.splice(0).join("\n") + "\n"
  const file = logFile()
  const size = await fs.stat(file).then((stat) => stat.size, () => 0)
  if (size + lines.length > LOG_MAX_BYTES) await fs.rename(file, `${file}.1`).catch(() => {})
  await fs.appendFile(file, lines, { mode: 0o600 }).catch(() => {})
}

/** Writes queued log records now (tests and shutdown). */
export function flushLog() {
  return flush()
}

function loopSummary() {
  const loop = state.loop
  if (!loop || loop.count === 0) return { maxMs: 0, p99Ms: 0, meanMs: 0 }
  // The histogram includes the sampling resolution; subtract it so an idle loop reads ~0.
  const ms = (value: number) => Math.max(0, Math.round(value / 1e6 - 20))
  return { maxMs: ms(loop.max), p99Ms: ms(loop.percentile(99)), meanMs: ms(loop.mean) }
}

function newStat(): Stat {
  return { n: 0, totalMs: 0, maxMs: 0, rows: 0, buckets: BUCKETS.map(() => 0).concat(0) }
}

function record(stat: Stat, ms: number, rows: number) {
  stat.n++
  stat.totalMs += ms
  stat.maxMs = Math.max(stat.maxMs, ms)
  stat.rows += rows
  const index = BUCKETS.findIndex((limit) => ms < limit)
  stat.buckets[index === -1 ? BUCKETS.length : index]!++
}

function add(map: Map<string, Stat>, key: string, ms: number, rows: number) {
  const slot = map.has(key) || map.size < MAX_KEYS ? key : "(other)"
  const target = map.get(slot) ?? newStat()
  map.set(slot, target)
  record(target, ms, rows)
}

function summary(stat: Stat) {
  return {
    n: stat.n,
    totalMs: Math.round(stat.totalMs),
    meanMs: stat.n ? Math.round((stat.totalMs / stat.n) * 10) / 10 : 0,
    maxMs: Math.round(stat.maxMs),
    rows: stat.rows,
    buckets: Object.fromEntries(stat.buckets.map((count, index) => [index < BUCKETS.length ? `<${BUCKETS[index]}ms` : `>=${BUCKETS.at(-1)}ms`, count])),
  }
}

function table(map: Map<string, Stat>, limit: number) {
  return [...map]
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, limit)
    .map(([key, stat]) => ({ key, ...summary(stat) }))
}

/** Statement text without literal values, whitespace-collapsed and truncated; cached per distinct text. */
function statementKey(text: string) {
  const cached = state.keys.get(text)
  if (cached) return cached
  const key = text
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .replace(/\(\?(, ?\?)+\)/g, "(?…)")
    .trim()
    .slice(0, 160)
  if (state.keys.size < 2_000) state.keys.set(text, key)
  return key
}

/** Path with identifier-like segments replaced, so routes aggregate and no IDs are retained. */
export function route(pathname: string) {
  return pathname
    .split("/")
    .map((segment) => (/\d/.test(segment) && segment.length >= 6) || segment.length > 40 ? ":id" : segment)
    .join("/")
    .slice(0, 80)
}

function mb(bytes: number) {
  return Math.round(bytes / 1024 / 1024)
}

async function prune(dir: string) {
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".cpuprofile")).sort()
  await Promise.all(files.slice(0, Math.max(0, files.length - PROFILE_KEEP)).map((name) => fs.rm(path.join(dir, name), { force: true })))
}

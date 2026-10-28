#!/usr/bin/env bun
// Summarises the installed app's performance journal (see src/perf-log.ts).
// Usage: bun scripts/perf-report.ts [--since 2h] [--dir DIR] [--json]
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { PERF_DIR } from "../src/perf-log"

const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const since = (() => {
  const match = /^(\d+)([mhd])$/.exec(arg("--since") ?? "2h")
  if (!match) throw new Error("--since takes e.g. 30m, 2h, 1d")
  return Date.now() - Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"]
})()
const dir = arg("--dir") ?? PERF_DIR

type Row = Record<string, unknown> & { kind: string; at: string }
const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".jsonl")).sort()
const rows = (await Promise.all(files.map((file) => readFile(path.join(dir, file), "utf8"))))
  .flatMap((text) => text.split("\n"))
  .flatMap((line) => {
    if (!line) return []
    try {
      const row = JSON.parse(line) as Row
      return Date.parse(row.at) >= since ? [row] : []
    } catch {
      return []
    }
  })

const quantiles = (values: number[]) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return sorted.length ? { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] } : { n: 0 }
}
const of = (kind: string) => rows.filter((row) => row.kind === kind)
const num = (row: Row, key: string) => (typeof row[key] === "number" ? (row[key] as number) : NaN)

const opens = of("session.open")
const snapshots = of("session.snapshot")
const proxy = of("proxy.request")
const routes = Object.entries(
  proxy.reduce<Record<string, number[]>>((acc, row) => {
    const route = String(row.route).replace(/ses_[A-Za-z0-9]+/g, ":id").replace(/msg_[A-Za-z0-9]+/g, ":msg")
    ;(acc[`${row.host} ${row.method} ${route}`] ??= []).push(num(row, "ms"))
    return acc
  }, {}),
)
  .map(([route, values]) => ({ route, ...quantiles(values) }))
  .sort((a, b) => (b.max ?? 0) - (a.max ?? 0))
  .slice(0, 12)
const count = <T extends string>(list: Row[], key: string) =>
  list.reduce<Record<string, number>>((acc, row) => {
    const value = String(row[key] as T)
    acc[value] = (acc[value] ?? 0) + 1
    return acc
  }, {})

// Startup: rows after each page.start (until the next) belong to that page; the native app
// runs one renderer window, so this grouping holds there. Journals older than ready.* events fall
// back to the first successful session.open (ends at the session record, i.e. target).
const pages = rows.flatMap((row, index) => {
  if (row.kind !== "page.start") return []
  const next = rows.findIndex((other, at) => at > index && other.kind === "page.start")
  const own = rows.slice(index + 1, next === -1 ? undefined : next)
  const level = (kind: string) => own.find((other) => other.kind === kind)
  const target = level("ready.target")
  const history = level("ready.history")
  const paint = own.find((other) => other.kind === "ready.paint" && other.name === "first-contentful-paint")
  const open = own.find((other) => other.kind === "session.open" && other.outcome === "ok")
  const early = own.filter((other) => num(other, "t") <= 30_000)
  const fetches = early.filter((other) => other.kind === "fetch").sort((a, b) => num(b, "ms") - num(a, "ms"))
  return [{
    at: row.at,
    route: row.route,
    navType: row.navType,
    domContentLoadedMs: row.domContentLoadedMs,
    // L0 paint, L1 target (Send enabled), L2 history; t = ms from navigation.
    paintMs: paint?.ms,
    target: target
      ? { t: target.t, direct: target.route === row.route, openMs: target.openMs }
      : open && { t: open.t, direct: open.route === row.route, openMs: open.ms, legacy: true },
    history: history ? { t: history.t, openMs: history.openMs } : open?.transcriptMs !== undefined ? { openMs: open.transcriptMs, legacy: true } : undefined,
    first30s: {
      longTaskMs: early.filter((other) => other.kind === "longtask").reduce((sum, other) => sum + num(other, "ms"), 0),
      stallMs: early.filter((other) => other.kind === "stall").reduce((sum, other) => sum + num(other, "ms"), 0),
      slowFetches: fetches.length,
      worstFetches: fetches.slice(0, 3).map((other) => ({ path: other.path, ms: other.ms, queueMs: other.queueMs, waitMs: other.waitMs })),
    },
  }]
})

const report = {
  window: { since: new Date(since).toISOString(), rows: rows.length, dir },
  sessionOpen: {
    interactiveMs: quantiles(opens.filter((row) => row.outcome === "ok").map((row) => num(row, "ms"))),
    coldInteractiveMs: quantiles(opens.filter((row) => row.outcome === "ok" && !row.cached).map((row) => num(row, "ms"))),
    transcriptMs: quantiles(opens.map((row) => num(row, "transcriptMs"))),
    leftBeforeUsable: opens.filter((row) => row.outcome === "left").length,
  },
  snapshot: Object.fromEntries(["session", "messages", "status", "todos"].map((key) => [key, quantiles(snapshots.map((row) => num(row, key)))])),
  snapshotOutcomes: count(snapshots, "outcome"),
  slowProxyRoutes: routes,
  renderer: {
    longTasksMs: quantiles(of("longtask").map((row) => num(row, "ms"))),
    stallsMs: quantiles(of("stall").map((row) => num(row, "ms"))),
    slowFetchQueueMs: quantiles(of("fetch").map((row) => num(row, "queueMs"))),
    longFramesMs: quantiles(of("longframe").map((row) => num(row, "ms"))),
    worstFrames: of("longframe")
      .sort((a, b) => num(b, "ms") - num(a, "ms"))
      .slice(0, 5)
      .map((row) => ({ at: row.at, route: row.route, ms: row.ms, styleLayoutMs: row.styleLayoutMs, scripts: row.scripts })),
  },
  startup: pages.slice(-10),
  streamCloses: count(of("events.closed"), "code"),
  trouble: count(of("session.trouble"), "trouble"),
  inputUnconfirmed: count(of("input.unconfirmed"), "path"),
}

if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2))
else {
  const line = (label: string, value: unknown) => console.log(`${label.padEnd(28)} ${typeof value === "string" ? value : JSON.stringify(value)}`)
  line("window", `${report.window.since} (${report.window.rows} rows)`)
  line("session open → input usable", report.sessionOpen.interactiveMs)
  line("  cold opens", report.sessionOpen.coldInteractiveMs)
  line("  transcript shown", report.sessionOpen.transcriptMs)
  line("  left before usable", report.sessionOpen.leftBeforeUsable)
  for (const [key, value] of Object.entries(report.snapshot)) line(`snapshot ${key}`, value)
  line("snapshot outcomes", report.snapshotOutcomes)
  line("renderer long tasks", report.renderer.longTasksMs)
  line("renderer stalls", report.renderer.stallsMs)
  line("slow fetch queueing", report.renderer.slowFetchQueueMs)
  line("long animation frames", report.renderer.longFramesMs)
  for (const frame of report.renderer.worstFrames) console.log(`  ${JSON.stringify(frame)}`)
  line("event stream closes", report.streamCloses)
  line("shown daemon trouble", report.trouble)
  line("input not confirmed", report.inputUnconfirmed)
  console.log("startup (last 10 pages; t = ms from navigation; direct = opened straight into the session; target = Send enabled):")
  for (const page of report.startup) console.log(`  ${JSON.stringify(page)}`)
  console.log("slowest proxied routes:")
  for (const route of report.slowProxyRoutes) console.log(`  ${route.route}  ${JSON.stringify({ n: route.n, p50: route.p50, p95: route.p95, max: route.max })}`)
}

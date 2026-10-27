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
  },
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
  line("event stream closes", report.streamCloses)
  line("shown daemon trouble", report.trouble)
  line("input not confirmed", report.inputUnconfirmed)
  console.log("slowest proxied routes:")
  for (const route of report.slowProxyRoutes) console.log(`  ${route.route}  ${JSON.stringify({ n: route.n, p50: route.p50, p95: route.p95, max: route.max })}`)
}

import { appendFile, chmod, mkdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

// Local performance journal for the installed app: renderer spans and long tasks,
// plus proxy timings that separate proxy, upstream wait and transfer. One JSONL
// file per UTC day, owner-only, capped so a runaway client cannot fill the disk.
export const PERF_DIR = process.env.ES_PERF_DIR ?? path.join(os.homedir(), ".local/share/opencode/es-perf")
const DAY_CAP = 64 * 1024 * 1024
const BODY_CAP = 256 * 1024
const RECORD_CAP = 4096
// Proxied requests faster than this are routine and not journaled.
const SLOW_MS = 250
// Long-lived streams are journaled only by how long they stayed open.
const STREAM = /\/(event|global\/event|api\/events)(\/|$|\?)/

export const createPerfLog = (options: { dir?: string; host?: string } = {}) => {
  const dir = options.dir ?? PERF_DIR
  const sizes = new Map<string, number>()
  let queue = Promise.resolve()
  const write = (records: object[]) => {
    const now = new Date()
    const file = path.join(dir, `${now.toISOString().slice(0, 10)}.jsonl`)
    const lines = records
      .map((record) => JSON.stringify({ at: now.toISOString(), host: options.host ?? "local", ...record }))
      .filter((line) => line.length <= RECORD_CAP)
      .join("\n")
    if (!lines) return queue
    queue = queue
      .then(async () => {
        if (!sizes.has(file)) {
          await mkdir(dir, { recursive: true, mode: 0o700 })
          sizes.set(file, await stat(file).then((value) => value.size, () => 0))
        }
        const size = sizes.get(file)!
        if (size > DAY_CAP) return
        await appendFile(file, `${lines}\n`, { mode: 0o600 })
        if (!size) await chmod(file, 0o600)
        sizes.set(file, size + lines.length + 1)
      })
      .catch(() => {})
    return queue
  }

  // Times one proxied request: request start -> upstream headers -> last byte.
  const proxy = (req: IncomingMessage, res: ServerResponse, route: string) => {
    const start = performance.now()
    let headers: number | undefined
    let status: number | undefined
    let bytes = 0
    const stream = STREAM.test(route)
    return {
      headers(code: number | undefined) {
        headers = performance.now()
        status = code
      },
      data(size: number) {
        bytes += size
      },
      done() {
        const total = performance.now() - start
        const aborted = !res.writableFinished
        if (stream) {
          if (total > 1000) void write([{ kind: "proxy.stream", route, method: req.method, status, openMs: Math.round(total), aborted }])
          return
        }
        // Fast client cancellations (navigation, reload, superseded reads) are routine.
        if (total < SLOW_MS && (status ?? 0) < 500) return
        void write([{
          kind: "proxy.request",
          route,
          method: req.method,
          status,
          ms: Math.round(total),
          waitMs: headers === undefined ? undefined : Math.round(headers - start),
          transferMs: headers === undefined ? undefined : Math.round(total - headers),
          bytes,
          aborted,
        }])
      },
    }
  }

  // Renderer reports: {events: [{kind, ...}]} from the trusted native origin only.
  const receive = async (req: IncomingMessage, finish: (status: number, body: string) => void) => {
    if (req.method !== "POST") return finish(405, "Method not allowed")
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > BODY_CAP) return finish(413, "Payload too large")
      chunks.push(chunk)
    }
    const body = (() => {
      try {
        return JSON.parse(Buffer.concat(chunks).toString()) as unknown
      } catch {
        return undefined
      }
    })()
    const events = body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
      ? ((body as { events: unknown[] }).events.filter(
          (event): event is Record<string, unknown> => !!event && typeof event === "object" && typeof (event as { kind?: unknown }).kind === "string",
        ))
      : undefined
    if (!events) return finish(400, "Expected {events: [...]}")
    void write(events.slice(0, 500).map((event) => ({ ...event, source: "renderer" })))
    finish(204, "")
  }

  return { write, proxy, receive, flushed: () => queue }
}

// Strips query strings and keeps the route shape; ids stay so a slow session can be found.
export const routeOf = (pathname: string) => pathname.length > 200 ? `${pathname.slice(0, 200)}…` : pathname

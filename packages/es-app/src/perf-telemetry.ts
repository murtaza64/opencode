/* Always-on, cheap client performance journal. Records what the user feels
 * (session open → transcript → composer usable, send latency, stalls) and
 * ships batches to the native host's `/__es/perf`, which appends them to a
 * local JSONL journal. Outside the native app the endpoint is absent and the
 * journal stays in memory (`window.__esPerf`). Nothing here may block the UI. */

type PerfEvent = { kind: string; [key: string]: unknown }

const FLUSH_MS = 5000
const RING = 500
// Resource timings under this are routine and not journaled.
const SLOW_RESOURCE_MS = 250
const LONG_TASK_MS = 100
const LONG_FRAME_MS = 200
const STALL_MS = 250

const ring: PerfEvent[] = []
let pending: PerfEvent[] = []
let sink: "unknown" | "native" | "off" = typeof window === "undefined" ? "off" : "unknown"
let timer: ReturnType<typeof setTimeout> | undefined
let started = false

const route = () => (typeof location === "undefined" ? "" : location.pathname.slice(0, 120))

export const perfEvent = (kind: string, fields: Record<string, unknown> = {}) => {
  const event = { kind, t: Math.round(performance.now()), route: route(), ...fields }
  ring.push(event)
  if (ring.length > RING) ring.shift()
  if (sink === "off") return
  pending.push(event)
  if (pending.length >= 100) return void flush()
  timer ??= setTimeout(() => void flush(), FLUSH_MS)
}

/** Measures one user-visible operation; `end` records it once with its outcome. */
export const perfSpan = (kind: string, fields: Record<string, unknown> = {}) => {
  const start = performance.now()
  let ended = false
  return {
    end: (outcome = "ok", extra: Record<string, unknown> = {}) => {
      if (ended) return
      ended = true
      perfEvent(kind, { ...fields, ...extra, outcome, ms: Math.round(performance.now() - start) })
    },
    elapsed: () => performance.now() - start,
  }
}

/** Times a promise without changing its result. */
export const perfTimed = <T>(promise: Promise<T>, record: (ms: number, ok: boolean) => void): Promise<T> => {
  const start = performance.now()
  return promise.then(
    (value) => {
      record(Math.round(performance.now() - start), true)
      return value
    },
    (error: unknown) => {
      record(Math.round(performance.now() - start), false)
      throw error
    },
  )
}

const flush = async () => {
  clearTimeout(timer)
  timer = undefined
  if (sink === "off" || !pending.length) return
  const events = pending
  pending = []
  const response = await fetch("/__es/perf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => undefined)
  if (response?.ok) {
    sink = "native"
    return
  }
  // No native journal here (browser preview, paired client): keep the in-memory ring only.
  if (response && [403, 404, 405].includes(response.status)) {
    sink = "off"
    pending = []
  }
}

/** Starts passive observers once per page. */
export const startPerfTelemetry = () => {
  if (started || typeof window === "undefined") return
  started = true
  ;(window as unknown as { __esPerf: () => PerfEvent[] }).__esPerf = () => [...ring]
  const observe = (type: string, callback: (entry: PerformanceEntry) => void) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(callback)).observe({ type, buffered: true })
    } catch {
      // Unsupported entry type in this runtime.
    }
  }
  // L0 shell: first paint/contentful paint since navigation.
  observe("paint", (entry) => perfEvent("ready.paint", { name: entry.name, ms: Math.round(entry.startTime) }))
  observe("longtask", (entry) => {
    if (entry.duration >= LONG_TASK_MS) perfEvent("longtask", { ms: Math.round(entry.duration) })
  })
  // Long tasks carry no attribution; animation frames name the scripts and split out style/layout.
  observe("long-animation-frame", (entry) => {
    if (entry.duration < LONG_FRAME_MS) return
    const frame = entry as PerformanceEntry & {
      blockingDuration?: number
      styleAndLayoutStart?: number
      scripts?: { duration: number; invoker?: string; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number }[]
    }
    perfEvent("longframe", {
      ms: Math.round(frame.duration),
      blockingMs: frame.blockingDuration === undefined ? undefined : Math.round(frame.blockingDuration),
      styleLayoutMs: frame.styleAndLayoutStart
        ? Math.round(frame.startTime + frame.duration - frame.styleAndLayoutStart)
        : undefined,
      scripts: [...(frame.scripts ?? [])]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 3)
        .map((script) => ({
          ms: Math.round(script.duration),
          fn: script.sourceFunctionName?.slice(0, 80) || undefined,
          src: script.sourceURL ? `${script.sourceURL.split("/").pop()?.slice(0, 80)}:${script.sourceCharPosition ?? ""}` : undefined,
          invoker: script.invoker?.slice(0, 80) || undefined,
        })),
    })
  })
  observe("resource", (entry) => {
    const timing = entry as PerformanceResourceTiming
    if (timing.duration < SLOW_RESOURCE_MS) return
    const url = new URL(timing.name, location.href)
    if (url.origin !== location.origin || !/^\/(oc|es)\//.test(url.pathname)) return
    perfEvent("fetch", {
      // A secure field's handle never leaves in a beacon.
      path: url.pathname.replace(/^(\/es\/api\/secret-intake\/)[^/]+$/, "$1:handle").slice(0, 200),
      ms: Math.round(timing.duration),
      // Time before the request left the browser: connection-pool queueing or a stalled main thread.
      queueMs: timing.requestStart ? Math.round(timing.requestStart - timing.startTime) : undefined,
      waitMs: timing.responseStart && timing.requestStart ? Math.round(timing.responseStart - timing.requestStart) : undefined,
      transferMs: timing.responseStart ? Math.round(timing.responseEnd - timing.responseStart) : undefined,
      bytes: timing.encodedBodySize || undefined,
    })
  })
  // Main-thread freezes long tasks miss (e.g. GC, layout outside tasks). Hidden pages are throttled.
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    const late = now - last - 500
    last = now
    if (late >= STALL_MS && document.visibilityState === "visible") perfEvent("stall", { ms: Math.round(late) })
  }, 500)
  window.addEventListener("pagehide", () => void flush())
  document.addEventListener("visibilitychange", () => {
    // Hidden pages are throttled; time spent hidden is not a stall.
    last = performance.now()
    if (document.visibilityState === "hidden") void flush()
  })
  // Navigation stages split bundle load/eval from app work on a cold first open.
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
  perfEvent("page.start", {
    ua: navigator.userAgent.slice(0, 120),
    navType: nav?.type,
    responseEndMs: nav ? Math.round(nav.responseEnd) : undefined,
    domInteractiveMs: nav ? Math.round(nav.domInteractive) : undefined,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : undefined,
  })
}

const levels = new Set<string>()

/** Records once per page when a readiness level first completes (ux-feel readiness contract:
 * L1 target = session record known, which also enables Send; L2 history = transcript tail loaded).
 * `t` counts from navigation, so a page opened straight into a session measures cold first-open. */
export const perfReady = (level: "target" | "history", fields: { sessionID: string; openMs: number }) => {
  if (levels.has(level)) return
  levels.add(level)
  perfEvent(`ready.${level}`, fields)
}

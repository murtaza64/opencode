/* Startup ordering for background reads (readiness contract; perf-lead step 2). On a cold open,
 * reads the open view does not need (other projects' lineage, every directory's status and
 * requests, the failure scan, the global session index) wait until the target is ready, then run at
 * most MAX_IN_FLIGHT at a time, so they neither queue in front of the target's own reads in the
 * browser's connection pool nor pile load onto Core at the same moment. Only a page opened straight
 * into a session waits; the gate opens when that session's record is known, or after GRACE_MS, so
 * nothing waits forever. Other pages start background reads at once (still capped). */

const MAX_IN_FLIGHT = 4
const GRACE_MS = 3000

let open = typeof location === "undefined" || !location.pathname.startsWith("/session/")
let release: () => void = () => {}
const gate = new Promise<void>((resolve) => { release = resolve })
const openGate = () => {
  if (open) return
  open = true
  release()
}
if (open) release()
else setTimeout(openGate, GRACE_MS)

/** The open view's target is usable (session record known); background reads may start. */
export const targetReady = openGate

let running = 0
const queue: (() => void)[] = []
const next = () => {
  if (running >= MAX_IN_FLIGHT) return
  const start = queue.shift()
  if (!start) return
  running++
  start()
}

/** Runs a background read after the target is ready, with at most MAX_IN_FLIGHT such reads in flight. */
export const background = async <T>(read: () => Promise<T>): Promise<T> => {
  if (!open) await gate
  await new Promise<void>((resolve) => { queue.push(resolve); next() })
  try {
    return await read()
  } finally {
    running--
    next()
  }
}

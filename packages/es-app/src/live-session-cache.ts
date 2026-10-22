/* Recently viewed live session stores, kept above the route so navigating back
 * renders the last transcript at once while a background snapshot reconciles it.
 * Each cached store keeps its event subscription (multiplexed over one socket),
 * so it stays current while hidden. */
import { createRoot, getOwner, onCleanup } from "solid-js"
import { createLiveSession } from "./live-session"

type LiveEvent = { type: string; properties?: any }
type Listener = (event: LiveEvent) => unknown
type Entry = {
  live: ReturnType<typeof createLiveSession>
  listeners: Set<Listener>
  users: number
  dispose: () => void
}

export const LIVE_SESSION_CACHE = 8
const entries = new Map<string, Entry>()

/** Store for one session, shared while mounted and retained (LRU) after unmount. */
export function useLiveSession(sessionID: string, directory: string, onEvent?: Listener) {
  const key = `${sessionID}\u0000${directory}`
  const entry = entries.get(key) ?? open(sessionID, directory)
  // Re-insert to mark most recently used.
  entries.delete(key)
  entries.set(key, entry)
  entry.users++
  if (onEvent) entry.listeners.add(onEvent)
  if (getOwner()) onCleanup(() => {
    if (onEvent) entry.listeners.delete(onEvent)
    entry.users--
    if (!entry.users) entry.live.suspend()
    evict()
  })
  evict()
  return entry.live
}

function open(sessionID: string, directory: string): Entry {
  const listeners = new Set<Listener>()
  return createRoot((dispose) => ({
    live: createLiveSession(sessionID, directory, (event) =>
      Promise.all([...listeners].map((listener) => listener(event)))),
    listeners,
    users: 0,
    dispose,
  }))
}

// Oldest unmounted stores go first; mounted stores are never evicted.
function evict() {
  for (const [key, entry] of entries) {
    if (entries.size <= LIVE_SESSION_CACHE) return
    if (entry.users > 0) continue
    entries.delete(key)
    entry.dispose()
  }
}

/** Test seam: drop every unmounted store. */
export function clearLiveSessions() {
  for (const [key, entry] of entries) {
    if (entry.users > 0) continue
    entries.delete(key)
    entry.dispose()
  }
}

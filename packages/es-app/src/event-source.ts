import { eventMuxPaths, eventProtocol, eventRecord } from "../event-protocol"
import { perfEvent } from "./perf-telemetry"

// Subscribers name the event type prefixes they reduce; the mux drops the rest.
export type EventFilter = { types?: string[] }

export type ServerEvents = {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  close: () => void
}

type Listener = { source: ServerEvents; types?: string[]; open?: boolean }
type Entry = { url: string; types?: string[]; source: ServerEvents; native?: EventSource; lastEventId?: string; listeners: Set<Listener>; opened: boolean }

/** The prefixes every listener of one stream needs: none (everything) if any listener takes everything. */
const mergedTypes = (listeners: Iterable<Listener>) => {
  const all = [...listeners]
  if (!all.length || all.some((item) => !item.types)) return undefined
  const union = [...new Set(all.flatMap((item) => item.types!))].sort()
  // The mux takes at most 16 prefixes. Past that the stream goes unfiltered and each listener filters for itself;
  // truncating would silently drop events some listener needs (h-r #932 S1).
  return union.length > 16 ? undefined : union
}
// The first "type" key is the payload type for instance and global envelopes, as the mux filters it.
const wanted = (listener: Listener, data: string) => {
  if (!listener.types) return true
  const type = /"type":"([^"]+)"/.exec(data)?.[1]
  return !type || listener.types.some((prefix) => type.startsWith(prefix))
}

/** Long-lived event streams over one WebSocket mux (or one native EventSource each without it). Subscribers of the same
 * URL share ONE upstream subscription and are fanned out here, each filtered by its own types (DD #922). A dropped
 * socket reconnects with backoff (retryMs doubling to 30 s); a paused hub (page hidden) holds no connection. */
export const createEventHub = (connect: () => WebSocket, capability: Promise<boolean>, retryMs = 1000) => {
  const sources = new Map<number, Entry>()
  const byURL = new Map<string, number>()
  let sequence = 0
  let enabled: boolean | undefined
  let socket: WebSocket | undefined
  // A socket stop() closed that has not finished closing: a new one waits for it (no overlap on quick hide/show).
  let closing: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let opening: ReturnType<typeof setTimeout> | undefined
  let paused = false
  let delay = retryMs
  const send = (message: object) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message))
  }
  const fanOut = (entry: Entry): ServerEvents => ({
    // A reopen without an error between (the stream re-sent with a wider filter) is not news to listeners that
    // already had their open: only those that have not resync (h-r #932 N1).
    onopen: (event) => {
      entry.opened = true
      entry.listeners.forEach((listener) => {
        if (listener.open) return
        listener.open = true
        listener.source.onopen?.(event)
      })
    },
    onerror: (event) => {
      entry.opened = false
      entry.listeners.forEach((listener) => {
        listener.open = false
        listener.source.onerror?.(event)
      })
    },
    onmessage: (event) => entry.listeners.forEach((listener) => {
      if (wanted(listener, event.data)) listener.source.onmessage?.(event)
    }),
    close: () => {},
  })
  const native = (entry: Entry) => {
    if (entry.native || paused) return
    entry.native = new EventSource(entry.url)
    entry.native.onopen = (event) => entry.source.onopen?.(event)
    entry.native.onerror = (event) => entry.source.onerror?.(event)
    entry.native.onmessage = (event) => entry.source.onmessage?.(event)
  }
  const retry = () => {
    timer = setTimeout(() => {
      timer = undefined
      open()
    }, delay)
    delay = Math.min(delay * 2, 30_000)
  }
  const open = () => {
    if (paused || !sources.size || socket || timer || closing || enabled === undefined) return
    if (!enabled) {
      sources.forEach(native)
      return
    }
    let current: WebSocket
    try {
      current = connect()
    } catch {
      sources.forEach((entry) => entry.source.onerror?.(new Event("error")))
      retry()
      return
    }
    socket = current
    opening = setTimeout(() => {
      if (socket !== current || current.readyState !== 0) return
      sources.forEach((entry) => entry.source.onerror?.(new Event("error")))
      current.close()
    }, 5000)
    current.onopen = () => {
      if (socket !== current) return
      clearTimeout(opening)
      opening = undefined
      sources.forEach((entry, id) => send({ type: "subscribe", id, url: entry.url, lastEventId: entry.lastEventId, types: entry.types }))
    }
    current.onmessage = (event) => {
      if (socket !== current || typeof event.data !== "string") return
      let message: unknown
      try {
        message = JSON.parse(event.data)
      } catch {
        current.close(1002)
        return
      }
      if (!eventRecord(message) || typeof message.id !== "number") return
      // Backoff resets only once the server actually serves a stream, not on an accept it closes at once (1013).
      delay = retryMs
      const entry = sources.get(message.id)
      if (!entry) return
      if (message.type === "open") entry.source.onopen?.(new Event("open"))
      if (message.type === "error") entry.source.onerror?.(new Event("error"))
      if (message.type === "message" && typeof message.data === "string") {
        entry.lastEventId = typeof message.lastEventId === "string" ? message.lastEventId : ""
        entry.source.onmessage?.(
          new MessageEvent("message", {
            data: message.data,
            lastEventId: entry.lastEventId,
          }),
        )
      }
    }
    current.onerror = () => {
      if (socket === current) sources.forEach((entry) => entry.source.onerror?.(new Event("error")))
    }
    current.onclose = (event) => {
      if (socket !== current) return
      // Every subscriber sees this as an error; journal the cause (1013 = consumer fell behind).
      perfEvent("events.closed", { code: event.code, reason: event.reason.slice(0, 120), subscribers: sources.size })
      clearTimeout(opening)
      opening = undefined
      socket = undefined
      sources.forEach((entry) => entry.source.onerror?.(new Event("error")))
      if (paused || !sources.size) return
      retry()
    }
  }
  const stop = () => {
    clearTimeout(timer)
    clearTimeout(opening)
    timer = undefined
    opening = undefined
    const previous = socket
    socket = undefined
    if (previous && previous.readyState < 2) {
      closing = previous
      previous.addEventListener?.("close", () => {
        if (closing !== previous) return
        closing = undefined
        open()
      })
    }
    previous?.close()
    sources.forEach((entry) => {
      entry.native?.close()
      entry.native = undefined
    })
  }
  void capability.then(
    (value) => {
      enabled = value
      open()
    },
    () => {
      enabled = false
      open()
    },
  )
  return {
    subscribe(url: string, filter: EventFilter = {}): ServerEvents {
      const listener: Listener = { source: { onopen: null, onerror: null, onmessage: null, close: () => {} }, types: filter.types }
      const existing = byURL.get(url)
      const id = existing ?? sequence++
      const entry: Entry = existing !== undefined ? sources.get(existing)! : { url, source: undefined as never, listeners: new Set(), opened: false }
      if (existing === undefined) {
        entry.source = fanOut(entry)
        sources.set(id, entry)
        byURL.set(url, id)
      }
      entry.listeners.add(listener)
      const types = mergedTypes(entry.listeners)
      const changed = JSON.stringify(types) !== JSON.stringify(entry.types)
      entry.types = types
      listener.source.close = () => {
        if (!entry.listeners.delete(listener)) return
        if (entry.listeners.size) {
          // A narrower filter is not worth a resubscribe: extra events are dropped client-side.
          return
        }
        entry.native?.close()
        sources.delete(id)
        byURL.delete(url)
        send({ type: "unsubscribe", id })
        if (!sources.size) stop()
      }
      if (existing !== undefined) {
        // Joining a live stream: this listener gets its own open, as a fresh subscription would.
        if (entry.opened) queueMicrotask(() => {
          if (!entry.listeners.has(listener) || listener.open) return
          listener.open = true
          listener.source.onopen?.(new Event("open"))
        })
        if (changed && socket?.readyState === 1) send({ type: "subscribe", id, url, lastEventId: entry.lastEventId, types })
        return listener.source
      }
      if (enabled === false) native(entry)
      if (socket?.readyState === 1) send({ type: "subscribe", id, url, types })
      else open()
      return listener.source
    },
    pause: () => {
      paused = true
      // Every listener resyncs on the open after resume: whatever happened while paused was not seen.
      sources.forEach((entry) => {
        entry.opened = false
        entry.listeners.forEach((listener) => { listener.open = false })
      })
      stop()
    },
    resume: () => {
      paused = false
      open()
    },
    close: () => {
      paused = true
      stop()
      sources.clear()
    },
  }
}

const hubs = new Map<string, ReturnType<typeof createEventHub>>()
let capability: Promise<boolean> | undefined

export const createServerEvents = (url: string, filter: EventFilter = {}): ServerEvents => {
  if (typeof window === "undefined") return new EventSource(url)
  capability ??= fetch("/__es/events")
    .then(async (response) => {
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel()
        return false
      }
      const value: unknown = await response.json()
      return eventRecord(value) && value.protocol === eventProtocol
    })
    .catch(() => false)
  // A Work view host's stream (/hosts/<id>/oc/...) shares the Core socket with this host's.
  const key = /^(?:\/hosts\/[a-z][a-z0-9-]*)?\/oc\//.test(url) ? "opencode" : "dashboard"
  let hub = hubs.get(key)
  if (!hub) {
    const target = new URL(eventMuxPaths[key], location.href)
    target.protocol = location.protocol === "https:" ? "wss:" : "ws:"
    hub = createEventHub(() => new WebSocket(target, eventProtocol), capability)
    hubs.set(key, hub)
  }
  return hub.subscribe(url, filter)
}

if (typeof window !== "undefined") {
  const pause = () => hubs.forEach((hub) => hub.pause())
  const resume = () => { if (document.visibilityState !== "hidden") hubs.forEach((hub) => hub.resume()) }
  // A hidden tab or window holds no stream; showing it resubscribes and every subscriber resyncs on its open.
  const visibility = () => document.visibilityState === "hidden" ? pause() : resume()
  window.addEventListener("pagehide", pause)
  window.addEventListener("pageshow", resume)
  document.addEventListener("visibilitychange", visibility)
  import.meta.hot?.dispose(() => {
    window.removeEventListener("pagehide", pause)
    window.removeEventListener("pageshow", resume)
    document.removeEventListener("visibilitychange", visibility)
    hubs.forEach((hub) => hub.close())
  })
}

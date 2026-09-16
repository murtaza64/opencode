import { eventMuxPaths, eventProtocol, eventRecord } from "../event-protocol"

export type ServerEvents = {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  close: () => void
}

export const createEventHub = (connect: () => WebSocket, capability: Promise<boolean>, retryMs = 1000) => {
  const sources = new Map<number, { url: string; source: ServerEvents; native?: EventSource; lastEventId?: string }>()
  let sequence = 0
  let enabled: boolean | undefined
  let socket: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let opening: ReturnType<typeof setTimeout> | undefined
  let paused = false
  const send = (message: object) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message))
  }
  const native = (entry: { url: string; source: ServerEvents; native?: EventSource }) => {
    if (entry.native || paused) return
    entry.native = new EventSource(entry.url)
    entry.native.onopen = (event) => entry.source.onopen?.(event)
    entry.native.onerror = (event) => entry.source.onerror?.(event)
    entry.native.onmessage = (event) => entry.source.onmessage?.(event)
  }
  const open = () => {
    if (paused || !sources.size || socket || timer || enabled === undefined) return
    if (!enabled) {
      sources.forEach(native)
      return
    }
    let current: WebSocket
    try {
      current = connect()
    } catch {
      sources.forEach((entry) => entry.source.onerror?.(new Event("error")))
      timer = setTimeout(() => {
        timer = undefined
        open()
      }, retryMs)
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
      sources.forEach((entry, id) => send({ type: "subscribe", id, url: entry.url, lastEventId: entry.lastEventId }))
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
    current.onclose = () => {
      if (socket !== current) return
      clearTimeout(opening)
      opening = undefined
      socket = undefined
      sources.forEach((entry) => entry.source.onerror?.(new Event("error")))
      if (paused || !sources.size) return
      timer = setTimeout(() => {
        timer = undefined
        open()
      }, retryMs)
    }
  }
  const stop = () => {
    clearTimeout(timer)
    clearTimeout(opening)
    timer = undefined
    opening = undefined
    const previous = socket
    socket = undefined
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
    subscribe(url: string): ServerEvents {
      const id = sequence++
      const source: ServerEvents = {
        onopen: null,
        onerror: null,
        onmessage: null,
        close: () => {
          sources.get(id)?.native?.close()
          if (!sources.delete(id)) return
          send({ type: "unsubscribe", id })
          if (!sources.size) stop()
        },
      }
      const entry = { url, source }
      sources.set(id, entry)
      if (enabled === false) native(entry)
      if (socket?.readyState === 1) send({ type: "subscribe", id, url })
      else open()
      return source
    },
    pause: () => {
      paused = true
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

export const createServerEvents = (url: string): ServerEvents => {
  // The protected Electron origin has no WebSocket bridge; retain its keyed HTTP transport.
  if (typeof window === "undefined" || /Electron\//.test(navigator.userAgent)) return new EventSource(url)
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
  const key = url.startsWith("/oc/") ? "opencode" : "dashboard"
  let hub = hubs.get(key)
  if (!hub) {
    const target = new URL(eventMuxPaths[key], location.href)
    target.protocol = location.protocol === "https:" ? "wss:" : "ws:"
    hub = createEventHub(() => new WebSocket(target, eventProtocol), capability)
    hubs.set(key, hub)
  }
  return hub.subscribe(url)
}

if (typeof window !== "undefined") {
  const pause = () => hubs.forEach((hub) => hub.pause())
  const resume = () => hubs.forEach((hub) => hub.resume())
  window.addEventListener("pagehide", pause)
  window.addEventListener("pageshow", resume)
  import.meta.hot?.dispose(() => {
    window.removeEventListener("pagehide", pause)
    window.removeEventListener("pageshow", resume)
    hubs.forEach((hub) => hub.close())
  })
}

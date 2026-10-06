import { EventSource } from "eventsource"
import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { eventMuxPaths, eventPaths, eventProtocol, eventRecord, type EventPacket } from "./event-protocol"

export const eventMux = (options: {
  origin: (request: IncomingMessage) => string
  authorize: (request: IncomingMessage, pathname: string) => boolean
  upstream: (prefix: "/oc" | "/es", requested: URL, request: IncomingMessage) => { url: string; headers?: HeadersInit }
  rejectUnknown?: boolean
}) => {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = request.url?.split("?")[0] ?? ""
    if (!Object.values(eventMuxPaths).includes(pathname)) {
      if (options.rejectUnknown) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return
    }
    if (request.headers["sec-websocket-protocol"] !== eventProtocol) {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n")
      return
    }
    if (!options.authorize(request, pathname)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return
    }
    const origin = options.origin(request)
    sockets.handleUpgrade(request, socket, head, (client) => {
      const prefix = pathname === eventMuxPaths.opencode ? "/oc" : "/es"
      const streams = new Map<number, EventSource>()
      const send = (packet: EventPacket) => {
        if (client.readyState !== WebSocket.OPEN) return
        if (client.bufferedAmount > 4 * 1024 * 1024) {
          client.close(1013, "Event consumer is behind; reconnect for a snapshot")
          return
        }
        client.send(JSON.stringify(packet))
      }
      client.on("message", (data) => {
        let message: unknown
        try {
          message = JSON.parse(data.toString())
        } catch {
          client.close(1008)
          return
        }
        if (!eventRecord(message) || typeof message.id !== "number" || !Number.isSafeInteger(message.id) || message.id < 0) {
          client.close(1008)
          return
        }
        const id = message.id
        if (message.type === "unsubscribe") {
          streams.get(id)?.close()
          streams.delete(id)
          return
        }
        if (message.type !== "subscribe" || typeof message.url !== "string" || (streams.size >= 16 && !streams.has(id))) {
          client.close(1008)
          return
        }
        if (message.lastEventId !== undefined && (typeof message.lastEventId !== "string" || message.lastEventId.length > 2048 || /[\r\n\0]/.test(message.lastEventId))) {
          client.close(1008)
          return
        }
        let lastEventId = typeof message.lastEventId === "string" ? message.lastEventId : ""
        const requested = URL.parse(message.url, origin)
        if (!requested || requested.origin !== origin || !eventPaths.includes(requested.pathname) || !requested.pathname.startsWith(prefix + "/")) {
          client.close(1008)
          return
        }
        streams.get(id)?.close()
        let target: ReturnType<typeof options.upstream>
        try {
          target = options.upstream(prefix, requested, request)
        } catch {
          send({ id, type: "error", code: 502 })
          return
        }
        const source = new EventSource(target.url, {
          fetch: (input, init) => {
            const headers = new Headers(init?.headers)
            new Headers(target.headers).forEach((value, name) => headers.set(name, value))
            if (lastEventId && !headers.has("last-event-id")) headers.set("last-event-id", lastEventId)
            headers.set("origin", origin)
            return fetch(input, { ...init, headers, redirect: "error" })
          },
        })
        streams.set(id, source)
        source.onopen = () => send({ id, type: "open" })
        source.onmessage = (event) => {
          lastEventId = event.lastEventId
          send({ id, type: "message", data: event.data, lastEventId })
        }
        source.onerror = (event) => send({ id, type: "error", code: event.code })
      })
      client.on("error", () => client.close())
      client.on("close", () => {
        streams.forEach((source) => source.close())
        streams.clear()
      })
    })
  }
  return {
    upgrade,
    close: () => {
      sockets.clients.forEach((client) => client.terminate())
      sockets.close()
    },
  }
}

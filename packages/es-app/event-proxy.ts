import { EventSource } from "eventsource"
import { WebSocketServer, WebSocket } from "ws"
import type { Plugin, PreviewServer, ViteDevServer } from "vite"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { eventMuxPaths, eventPaths, eventProtocol, eventRecord, type EventPacket } from "./event-protocol"

export const eventProxy = (targets: { opencode: string; dashboard: string }): Plugin => {
  const cleanups = new Set<() => void>()
  const configure = (server: ViteDevServer | PreviewServer) => {
    const http = server.httpServer
    if (!http) return
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
    const loopback = (host: string | undefined) => {
      try {
        return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${host}`).hostname)
      } catch {
        return false
      }
    }
    server.middlewares.use((request, response, next) => {
      if (request.method !== "GET" || request.url !== "/__es/events") return next()
      response.setHeader("content-type", "application/json")
      response.setHeader("cache-control", "no-store")
      response.end(JSON.stringify({ protocol: loopback(request.headers.host) ? eventProtocol : null }))
    })
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = request.url?.split("?")[0]
      if (request.headers["sec-websocket-protocol"] !== eventProtocol) {
        if (Object.values(eventMuxPaths).includes(pathname ?? ""))
          socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n")
        return
      }
      const scheme = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http"
      const origin = `${scheme}://${request.headers.host}`
      if (
        !loopback(request.headers.host) ||
        request.headers.origin !== origin ||
        !Object.values(eventMuxPaths).includes(pathname ?? "")
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
        return
      }
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
          if (
            !eventRecord(message) ||
            typeof message.id !== "number" ||
            !Number.isSafeInteger(message.id) ||
            message.id < 0
          ) {
            client.close(1008)
            return
          }
          const id = message.id
          if (message.type === "unsubscribe") {
            streams.get(id)?.close()
            streams.delete(id)
            return
          }
          if (message.type !== "subscribe" || typeof message.url !== "string" || streams.size >= 16) {
            client.close(1008)
            return
          }
          if (
            message.lastEventId !== undefined &&
            (typeof message.lastEventId !== "string" ||
              message.lastEventId.length > 2048 ||
              /[\r\n\0]/.test(message.lastEventId))
          ) {
            client.close(1008)
            return
          }
          let lastEventId = typeof message.lastEventId === "string" ? message.lastEventId : ""
          let requested: URL
          try {
            requested = new URL(message.url, origin)
          } catch {
            client.close(1008)
            return
          }
          if (
            requested.origin !== origin ||
            !eventPaths.includes(requested.pathname) ||
            !requested.pathname.startsWith(prefix + "/")
          ) {
            client.close(1008)
            return
          }
          streams.get(id)?.close()
          let target: ReturnType<typeof resolveUpstream>
          try {
            target = resolveUpstream(prefix === "/oc" ? targets.opencode : targets.dashboard, requested, prefix)
          } catch {
            send({ id, type: "error", code: 502 })
            return
          }
          const source = new EventSource(target.url, {
            fetch: (input, init) => {
              const headers = new Headers(init?.headers)
              const authorization = request.headers.authorization ?? target.authorization
              if (authorization) headers.set("authorization", authorization)
              if (request.headers.cookie) headers.set("cookie", request.headers.cookie)
              if (lastEventId && !headers.has("last-event-id")) headers.set("last-event-id", lastEventId)
              headers.set("origin", origin)
              // Never forward credentials through an upstream redirect.
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
    http.on("upgrade", upgrade)
    const close = () => {
      if (!cleanups.delete(close)) return
      http.off("upgrade", upgrade)
      http.off("close", close)
      sockets.clients.forEach((client) => client.terminate())
      sockets.close()
    }
    cleanups.add(close)
    http.once("close", close)
  }
  return {
    name: "es-app:event-proxy",
    configureServer: configure,
    configurePreviewServer: configure,
    closeBundle: () => {
      cleanups.forEach((close) => close())
    },
  }
}

const resolveUpstream = (base: string, requested: URL, prefix: string) => {
  const target = new URL(base)
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported event upstream")
  target.pathname = target.pathname.replace(/\/$/, "") + requested.pathname.slice(prefix.length)
  target.search = [target.search.slice(1), requested.search.slice(1)].filter(Boolean).join("&")
  const authorization =
    target.username || target.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString("base64")}`
      : undefined
  target.username = ""
  target.password = ""
  return { url: target.href, authorization }
}

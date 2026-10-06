import type { Plugin, PreviewServer, ViteDevServer } from "vite"
import { eventProtocol } from "./event-protocol"
import { eventMux } from "./event-mux"

export const eventProxy = (targets: { opencode: string; dashboard: string }): Plugin => {
  const cleanups = new Set<() => void>()
  const configure = (server: ViteDevServer | PreviewServer) => {
    const http = server.httpServer
    if (!http) return
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
    const mux = eventMux({
      origin: (request) => `${"encrypted" in request.socket && request.socket.encrypted ? "https" : "http"}://${request.headers.host}`,
      authorize: (request) => {
        const scheme = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http"
        return loopback(request.headers.host) && request.headers.origin === `${scheme}://${request.headers.host}`
      },
      upstream: (prefix, requested, request) => {
        const target = new URL(prefix === "/oc" ? targets.opencode : targets.dashboard)
        if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported event upstream")
        target.pathname = target.pathname.replace(/\/$/, "") + requested.pathname.slice(prefix.length)
        target.search = [target.search.slice(1), requested.search.slice(1)].filter(Boolean).join("&")
        const authorization =
          request.headers.authorization ??
          (target.username || target.password
            ? `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString("base64")}`
            : undefined)
        target.username = ""
        target.password = ""
        return { url: target.href, headers: { ...(authorization ? { authorization } : {}), ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) } }
      },
    })
    http.on("upgrade", mux.upgrade)
    const close = () => {
      if (!cleanups.delete(close)) return
      http.off("upgrade", mux.upgrade)
      http.off("close", close)
      mux.close()
    }
    cleanups.add(close)
    http.once("close", close)
  }
  return {
    name: "es-app:event-proxy",
    configureServer: configure,
    configurePreviewServer: configure,
    closeBundle: () => cleanups.forEach((close) => close()),
  }
}

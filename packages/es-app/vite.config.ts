import tailwindcss from "@tailwindcss/vite"
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { apiProxy } from "./api-proxy"
import { eventProxy } from "./event-proxy"
import { isSurfacePath, surfaceProxy } from "./surface-proxy"
import { localHost, remoteHosts, remoteOrigin, remoteTargets, type HostInfo } from "./remote-host"

// One listener per execution host. ES_REMOTE_ORIGIN makes this listener a remote host's
// (ES_HOST_ID/ES_HOST_LABEL name it); ES_HOSTS lists every host's laptop listener for the switcher.
const remote = process.env.ES_REMOTE_ORIGIN
  ? { id: remoteHosts([{ id: process.env.ES_HOST_ID, label: process.env.ES_HOST_LABEL, origin: process.env.ES_REMOTE_ORIGIN }])[0].id, origin: remoteOrigin(process.env.ES_REMOTE_ORIGIN) }
  : undefined
const targets = remote
  ? remoteTargets(remote.origin)
  : {
      opencode: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
      dashboard: process.env.ES_DASHBOARD_URL ?? "http://127.0.0.1:7777",
    }
const host: HostInfo = (() => {
  const hosts = process.env.ES_HOSTS ? listenerHosts(JSON.parse(process.env.ES_HOSTS)) : []
  const id = remote?.id ?? "local"
  const label = hosts.find((item) => item.id === id)?.label ?? process.env.ES_HOST_LABEL ?? (remote ? id : localHost.label)
  return { id, label, remote: !!remote, hosts }
})()

const hostInfo: Plugin = {
  name: "es-app:host",
  configureServer: (server) => serveHost(server),
  configurePreviewServer: (server) => serveHost(server),
}

// Firefox loads worker scripts through the HTTP cache even on hard reload; a
// poisoned (empty) cache entry revived by vite's 304 revalidation yields
// "Worker from an empty source" and Pierre's highlighter pool hangs forever.
// Force full 200s for worker files so the browser cache self-heals.
const workerNo304: Plugin = {
  name: "es-app:worker-no-304",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.includes("worker_file")) {
        delete req.headers["if-none-match"]
        delete req.headers["if-modified-since"]
      }
      next()
    })
  },
}

// Agent-owned Front Desk surfaces, same routes as the native server.
const surfaces = (): Plugin => {
  const proxy = surfaceProxy({ dashboard: targets.dashboard })
  // Registered before Vite's own middlewares, so the page fallback never answers these paths.
  const use = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url ?? "").split("?")[0]
      if (!isSurfacePath(pathname)) return next()
      if (pathname.startsWith("/__es/surface/")) return proxy.address(req, res)
      void proxy.serve(req, res)
    })
  }
  return { name: "es-app:surfaces", configureServer: use, configurePreviewServer: use }
}

export default defineConfig({
  // Surface upstreams are loopback addresses on the dashboard's machine; a remote host's are never resolved here.
  plugins: [solid(), tailwindcss(), workerNo304, hostInfo, eventProxy(targets, remote), ...(remote ? [] : [surfaces()])],
  worker: {
    format: "es",
  },
  server: {
    port: 3100,
    // spike: proxy the daemon so the browser stays same-origin (CORS check
    // against :4096 direct is a later step)
    proxy: {
      "/oc": apiProxy(targets.opencode, "/oc", remote),
      "/es": apiProxy(targets.dashboard, "/es", remote),
    },
  },
  build: {
    target: "esnext",
  },
})

function serveHost(server: ViteDevServer | PreviewServer) {
  server.middlewares.use((req, res, next) => {
    if (req.url !== "/__es/host") return next()
    res.setHeader("content-type", "application/json")
    res.setHeader("cache-control", "no-store")
    res.end(JSON.stringify(host))
  })
}

// Laptop listeners for each host: loopback http origins (local included), shown in the host switcher.
function listenerHosts(value: unknown) {
  if (!Array.isArray(value)) throw new Error("ES_HOSTS must be a list")
  return value.map((item: Record<string, unknown>) => {
    const url = URL.parse(String(item?.origin))
    if (!url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || typeof item.id !== "string" || typeof item.label !== "string")
      throw new Error("ES_HOSTS entries need id, label and an http://127.0.0.1:PORT origin")
    return { id: item.id, label: item.label, origin: url.origin }
  })
}

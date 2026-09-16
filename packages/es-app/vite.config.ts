import tailwindcss from "@tailwindcss/vite"
import { defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"
import { apiProxy } from "./api-proxy"
import { eventProxy } from "./event-proxy"

const targets = {
  opencode: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
  dashboard: process.env.ES_DASHBOARD_URL ?? "http://127.0.0.1:7777",
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

export default defineConfig({
  plugins: [solid(), tailwindcss(), workerNo304, eventProxy(targets)],
  worker: {
    format: "es",
  },
  server: {
    port: 3100,
    // spike: proxy the daemon so the browser stays same-origin (CORS check
    // against :4096 direct is a later step)
    proxy: {
      "/oc": apiProxy(targets.opencode, "/oc"),
      "/es": apiProxy(targets.dashboard, "/es"),
    },
  },
  build: {
    target: "esnext",
  },
})

import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"

export const createRenderer = () =>
  createServer({
    root: fileURLToPath(new URL("../../es-app", import.meta.url)),
    plugins: [
      {
        name: "editspace:no-native-editor",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.split("?")[0].toLowerCase().startsWith("/__open-in-editor")) return next()
            res.writeHead(403)
            res.end("Native editor access disabled")
          })
        },
      },
    ],
    // The authenticated shell owns API routing, never Vite's default service proxies.
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      proxy: { "/oc": { bypass: () => false }, "/es": { bypass: () => false } },
      fs: { strict: true, allow: [path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))] },
    },
  })

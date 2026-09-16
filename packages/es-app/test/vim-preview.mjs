import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"

const fixture = await createFixture()
process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const destination = `/session/ses_a?directory=${encodeURIComponent(directory)}`
const draft = {
  text:
    "Visual j/k follows wrapped rows. Logical gj/gk skips to the next buffer line. ".repeat(8) +
    "\nshort\n" +
    "The horizontal goal survives a short line. Try 3j, 2gk, gg and G. ".repeat(6) +
    "\n\n\tTabs and Unicode: \u{1f469}\u200d\u{1f4bb} e\u0301\nResize the window, type in insert mode, and scroll.\n",
  images: [],
  model: null,
  selection: [0, 0],
  revision: 0,
}
const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "vim-demo",
    configureServer(server) {
      server.middlewares.use("/vim-demo", (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        res.end(
          `<script>sessionStorage.setItem(${JSON.stringify(`es-app:composer:1:${JSON.stringify(["ses_a", directory])}`)}, ${JSON.stringify(JSON.stringify({ version: 1, mode: "queue", task: draft, aside: { ...draft, text: "Separate Aside draft" }, asideSeeded: true }))}); location.replace(${JSON.stringify(destination)});</script>`,
        )
      })
    },
  }],
})
await vite.listen()
console.log(`Mock-only Vim preview: http://127.0.0.1:${vite.httpServer.address().port}/vim-demo`)
console.log(`PID: ${process.pid}; fixture: ${fixture.url}`)
const stop = async () => {
  await vite.close()
  await fixture.close()
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

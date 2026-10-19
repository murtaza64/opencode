import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const site = await startPanelPreview([{
  name: "sidebar-live-fixture-controls",
  transformIndexHtml: (html) => html.replace("</body>", `<aside style="position:fixed;inset-block-end:12px;inset-inline-end:12px;z-index:10000;background:#181825;padding:12px;border:1px solid #9399b2;color:#cdd6f4">
    Disposable fixture · no live sessions
    <button onclick="fetch('/__fixture/sidebar?status=busy')">Busy</button>
    <button onclick="fetch('/__fixture/sidebar?status=idle')">Idle</button>
    <button onclick="fetch('/__fixture/sidebar?status=retry')">Retry</button>
    <button onclick="fetch('/__fixture/sidebar?status=reconnect')">Reconnect</button>
  </aside></body>`),
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url, "http://fixture")
      if (url.pathname !== "/__fixture/sidebar") return next()
      const type = url.searchParams.get("status")
      if (type === "reconnect") {
        for (const [stream, entry] of site.fixture.eventStreams) if (entry.path === "/global/event") stream.end()
      }
      if (["busy", "idle", "retry"].includes(type)) {
        site.fixture.setStatus(type)
        for (const [stream, entry] of site.fixture.eventStreams) if (entry.path === "/global/event")
          stream.write(`data: ${JSON.stringify({ directory, payload: { type: "session.status", properties: {
            sessionID: "ses_a", status: { type },
          } } })}\n\n`)
      }
      response.writeHead(204)
      response.end()
    })
  },
}])
console.log(`PREVIEW ${site.url}\nSTOP kill ${process.pid}`)
const close = async () => { await site.close(); process.exit(0) }
process.once("SIGINT", close)
process.once("SIGTERM", close)

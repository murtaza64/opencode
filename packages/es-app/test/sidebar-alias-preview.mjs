import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const alias = "/fixture symlink with spaces/a&b?#"
let dashboardDirectory = alias
let globalDirectory = directory
const publish = (directory, type, properties) => {
  for (const [response, stream] of site.fixture.eventStreams) if (stream.path === "/global/event")
    response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
}
const site = await startPanelPreview([{
  name: "sidebar-alias-fixture-controls",
  transformIndexHtml: (html) => html.replace("</body>", `<aside style="position:fixed;inset-block-end:12px;inset-inline-end:12px;z-index:10000;background:#181825;padding:12px;border:1px solid #9399b2;color:#cdd6f4">
    Same Session ID · disposable directory aliases
    <button onclick="fetch('/__fixture/alias?directory=canonical')">Canonical</button>
    <button onclick="fetch('/__fixture/alias?directory=alias')">Alias</button>
    <button onclick="fetch('/__fixture/alias?status=idle')">Idle</button>
    <button onclick="fetch('/__fixture/alias?status=busy')">Busy</button>
  </aside></body>`),
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://fixture")
      if (url.pathname === "/es/api/state") {
        const state = await (await fetch(`${site.fixture.url}/api/state`)).json()
        state.threads[0].sessions[0].directory = dashboardDirectory
        response.setHeader("content-type", "application/json")
        return response.end(JSON.stringify(state))
      }
      if (url.pathname === "/oc/experimental/session") {
        response.setHeader("content-type", "application/json")
        return response.end(JSON.stringify([{ ...session("ses_a"), directory: globalDirectory }, session("ses_b")]))
      }
      if (url.pathname !== "/__fixture/alias") return next()
      if (url.searchParams.has("directory")) {
        globalDirectory = dashboardDirectory = url.searchParams.get("directory") === "alias" ? alias : directory
        site.fixture.emitDashboard("changed")
        publish(globalDirectory, "session.updated", { sessionID: "ses_a", info: { ...session("ses_a"), slug: "fixture", directory: globalDirectory } })
      }
      const type = url.searchParams.get("status")
      if (type === "busy" || type === "idle") {
        site.fixture.setStatus(type)
        publish(globalDirectory === directory ? alias : directory, "session.status", { sessionID: "ses_a", status: { type } })
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

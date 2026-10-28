// Real-client preview of the secret decision field: the es-app dev UI with its attention and secure intake
// calls forwarded to the real dashboard routes in dotfiles tests/secret_intake_fixture.py (fake consumer,
// private editspace). Enter only made-up canaries.
//   ES_DOTFILES=~/dotfiles node test/secret-field-preview.mjs [port]
import { spawn } from "node:child_process"
import net from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const dotfiles = process.env.ES_DOTFILES ?? path.join(homedir(), "dotfiles")
const port = Number(process.argv[2] ?? 0) || await new Promise(resolve => {
  const probe = net.createServer()
  probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)) })
})
const origin = `http://127.0.0.1:${port}`
const dashboard = spawn("uv", ["run", "--with", "fastapi", "--with", "httpx", "--with", "uvicorn", "python", path.join(dotfiles, "tests/secret_intake_fixture.py"), "--origin", origin],
  { stdio: ["ignore", "pipe", "inherit"] })
const ready = await new Promise((resolve, reject) => {
  createInterface({ input: dashboard.stdout }).once("line", line => resolve(JSON.parse(line)))
  dashboard.once("exit", code => reject(Error(`fixture exited ${code}`)))
})
// Forward only the two real routes; the browser's Origin and cookie go through unchanged, as the app proxy does.
const forward = (prefix) => async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const headers = Object.fromEntries(["cookie", "origin", "content-type", "x-attention-csrf", "sec-fetch-site"].flatMap(name => req.headers[name] ? [[name, req.headers[name]]] : []))
  // Connect strips the mount prefix and leaves "/" for the bare route; the dashboard has no trailing-slash routes.
  const rest = req.url.replace(/^\/(?=\?|$)/, "")
  const response = await fetch(`${ready.url}${prefix}${rest}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" })
  const out = { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" }
  const cookies = response.headers.getSetCookie()
  if (cookies.length) out["set-cookie"] = cookies
  res.writeHead(response.status, out)
  res.end(Buffer.from(await response.arrayBuffer()))
}
const preview = await startPanelPreview([{
  name: "secret-intake-real-routes",
  // The fixture project is not one of the preview runtime's projects; show all projects so its card is listed.
  transformIndexHtml() {
    return [{ tag: "script", children: `localStorage.setItem("es-app-all-projects", "true")` }]
  },
  configureServer(server) {
    server.middlewares.use("/es/api/secret-intake", forward("/api/secret-intake"))
    server.middlewares.use("/es/api/attention", forward("/api/attention"))
  },
}], port)
const item = ready.seeds[0]
console.log([
  `PREVIEW ${origin}/?item=${encodeURIComponent(`attention:secret-preview:${item.record}`)}`,
  `FIXTURE ${ready.identity}  (journal state + consumer digest; no values)`,
  `NEW CARD curl -s -X POST -H 'X-Attention-CSRF: 1' ${ready.url}/fixture/seed`,
  `STOP kill ${process.pid}  (also stops fixture pid ${ready.pid}; private root ${ready.root})`,
].join("\n"))
const close = async () => { dashboard.kill("SIGTERM"); await preview.close(); process.exit(0) }
process.on("SIGINT", close)
process.on("SIGTERM", close)

import { createServer as createHttpServer } from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const directory = "/attention/root"
const childDirectory = "/attention/child"
const root = { id: "ses_root", title: "Attention root", directory, projectID: "fixture", agent: "build", version: "1", time: { created: 1, updated: 2 } }
const child = { ...root, id: "ses_child", title: "Child", directory: childDirectory, parentID: root.id }
const rows = [root, child]
const permission = { id: "per_child", sessionID: child.id, permission: "bash", patterns: ["fixture command"], metadata: {}, always: [] }
let notifications = [{ id: `idle:${root.id}`, kind: "idle", session: root.id, title: root.title, directory, editspace: "fixture", updated: Date.now() - 1000 }]
let statuses = { [root.id]: { type: "busy" } }
let permissions = []
const streams = new Set()
const failures = []
const server = createHttpServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture")
  const path = url.pathname
  const dir = url.searchParams.get("directory")
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)) }
  if (req.method !== "GET") { failures.push(`Unexpected mutation ${req.method} ${path}`); return json({}, 405) }
  if (["/event", "/global/event", "/api/events", "/api/notification-events"].includes(path)) {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": connected\n\n")
    const stream = { path, dir, res }; streams.add(stream); req.on("close", () => streams.delete(stream)); return
  }
  if (path === "/api/editspaces") return json({ editspaces: [{ name: "fixture", root: directory }], default: "fixture" })
  if (path === "/api/notifications") return json({ notifications })
  if (path === "/api/state") return json({ editspace: "fixture", root: directory, threads: [{ kind: "session", key: root.id, title: root.title, sessions: [{ ...root, updated: 2, live: "busy" }], lanes: [], tickets: [], prs: [] }], attention: [], frontier: [], unattached_prs: [] })
  if (path === "/experimental/session") return json(rows)
  if (path === "/session") return json(rows.filter((s) => s.directory === dir))
  if (path === "/session/status") return json(Object.fromEntries(rows.filter((s) => s.directory === dir && statuses[s.id]).map((s) => [s.id, statuses[s.id]])))
  if (path === "/permission") return json(permissions.filter((p) => rows.find((s) => s.id === p.sessionID)?.directory === dir))
  if (path === "/question") return json([])
  if (path === "/api/issues") return json({ backend: "gh", repo: "fixture/repo", issues: [] })
  if (path === "/api/docs") return json({ sources: [], roots: [] })
  failures.push(`Unexpected read ${path}`); return json({}, 404)
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const fixtureUrl = `http://127.0.0.1:${server.address().port}`
process.env.OPENCODE_URL = fixtureUrl
process.env.ES_DASHBOARD_URL = fixtureUrl
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const context = await browser.newContext()
await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
await context.route("**/*", (route) => {
  const url = new URL(route.request().url())
  if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) return route.continue()
  failures.push(`External request ${url.origin}`); return route.abort()
})
const page = await context.newPage()
page.on("pageerror", (e) => failures.push(e.message))
const emit = (directory, event) => {
  for (const stream of streams) {
    if (stream.path === "/global/event") stream.res.write(`data: ${JSON.stringify({ directory, payload: event })}\n\n`)
    if (stream.path === "/api/notification-events") stream.res.write("data: {}\n\n")
  }
}
try {
  await page.goto(origin)
  await expect(page.locator('.sidebar > a[href^="/session/ses_root"] .dot')).toHaveClass(/busy/)
  await expect(page.locator(".notification-item")).toHaveCount(0)
  console.log("PASS busy/no-needs does not enter Needs You despite a retained idle record")
  permissions = [permission]
  emit(childDirectory, { type: "permission.asked", properties: permission })
  await expect(page.locator(".notification-item")).toHaveCount(1)
  await expect(page.locator(".notification-item")).toHaveAttribute("href", `/session/${root.id}?directory=${encodeURIComponent(directory)}`)
  console.log("PASS busy parent retains genuine blocked descendant attention")
  notifications = [{ id: `permission:${permission.id}`, kind: "permission", session: child.id, title: child.title, directory: childDirectory, editspace: "fixture", updated: Date.now() }]
  permissions = []
  emit(childDirectory, { type: "permission.replied", properties: { sessionID: child.id, requestID: permission.id, reply: "once" } })
  await expect(page.locator(".notification-item")).toHaveCount(0)
  console.log("PASS replied descendant gate removes stale dashboard attention")
  statuses = { [child.id]: { type: "busy" } }
  notifications = [{ id: `idle:${root.id}`, kind: "idle", session: root.id, title: root.title, directory, editspace: "fixture", updated: Date.now() }]
  emit(directory, { type: "session.status", properties: { sessionID: root.id, status: { type: "idle" } } })
  emit(childDirectory, { type: "session.status", properties: { sessionID: child.id, status: { type: "busy" } } })
  await expect(page.locator(".notification-item")).toHaveCount(0)
  console.log("PASS busy descendant alone is activity, not attention")
  expect(failures).toEqual([])
} finally {
  await browser.close()
  for (const stream of streams) stream.res.end()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await vite.close()
}

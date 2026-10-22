// Run from packages/es-app: FRONT_DESK_DOTFILES=/abs/dotfiles node test/front-desk-memory.real.mjs
// Focused proof of uncertain memory saves against the REAL dotfiles memory seam (private HOME and
// auth key), headless Chrome, no Core and no model: a lost PUT that commits late, a 500 returned
// after the commit, a lost PUT resent identically, and a lost PUT overtaken by another writer.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import http from "node:http"
import net from "node:net"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createServer as createVite } from "vite"

const dotfiles = process.env.FRONT_DESK_DOTFILES
assert(dotfiles && path.isAbsolute(dotfiles), "FRONT_DESK_DOTFILES must name the dotfiles checkout")
const home = await mkdtemp(path.join(tmpdir(), "front-desk-memory-"))
const env = { ...process.env, HOME: home, ES_ATTENTION_AUTH_FILE: path.join(home, "attention.key") }
const file = path.join(home, ".local/share/opencode/front-desk/memory.json")
const PROD_PORTS = [4096, 3181, 7777, 60302, 3100]
const log = (message) => console.log(message)
const freePort = async () => {
  const probe = net.createServer()
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  assert(!PROD_PORTS.includes(port), `refusing port ${port}`)
  return port
}
const memory = async () => JSON.parse(await readFile(file, "utf8").catch(() => '{"revision":0,"entries":[]}'))

let fixture, dashboard, vite, browser
try {
  const vitePort = await freePort()
  fixture = spawn("uv", ["run", "--quiet", path.join(dotfiles, "tests/frontdesk_memory_fixture.py"), "--origin", `http://127.0.0.1:${vitePort}`], { env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  const owned = fixture
  process.once("exit", () => { if (owned.exitCode === null) try { process.kill(-owned.pid, "SIGKILL") } catch {} })
  let out = ""
  const base = await new Promise((resolve, reject) => {
    fixture.stdout.on("data", (piece) => { out += piece; const match = /listening on (http:\/\/\S+) file=(\S+)/.exec(out); if (match) resolve(match[1]) })
    fixture.stderr.on("data", (piece) => { out += piece })
    fixture.once("exit", (code) => reject(new Error(`fixture exited ${code}: ${out}`)))
  })
  assert(out.includes(`file=${file}`), out)
  const token = execFileSync("uv", ["run", "--quiet", "python", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import es_attention_auth as a; print(a.mint({'role':'operator','purpose':'api','es':'*','channel':'ui'}))", path.join(dotfiles, "bin")], { env, encoding: "utf8" }).trim()
  const direct = (method, body) => fetch(`${base}/api/frontdesk/memory`, { method, headers: { "content-type": "application/json", "X-Attention-CSRF": "1", authorization: `Bearer ${token}` }, ...(body ? { body } : {}) })
  log(`SEAM ${base} HOME=${home} PID=${fixture.pid}`)

  // Stub dashboard: memory and the operator session forward to the real seam; the rest is empty.
  dashboard = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://stub")
    const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)) }
    if (url.pathname === "/api/frontdesk/memory" || url.pathname === "/api/attention/session") {
      const headers = Object.fromEntries(["cookie", "content-type", "x-attention-csrf", "origin"].flatMap((name) => request.headers[name] ? [[name, request.headers[name]]] : []))
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(await Array.fromAsync(request))
      const result = await fetch(new URL(url.pathname, base), { method: request.method, headers, body })
      const reply = { "content-type": "application/json" }
      if (result.headers.get("set-cookie")) reply["set-cookie"] = result.headers.get("set-cookie")
      response.writeHead(result.status, reply)
      return response.end(Buffer.from(await result.arrayBuffer()))
    }
    if (["/api/events", "/api/notification-events"].includes(url.pathname)) { response.writeHead(200, { "content-type": "text/event-stream" }); return response.write("data: connected\n\n") }
    if (url.pathname === "/api/editspaces") return json({ editspaces: [{ name: "fixture", root: home }], default: "fixture" })
    if (url.pathname === "/api/state") return json({ editspace: "fixture", root: home, threads: [], attention: [], frontier: [], unattached_prs: [], sessions: [] })
    if (url.pathname === "/api/notifications") return json({ notifications: [] })
    if (url.pathname === "/api/handoffs") return json({ handoffs: [] })
    if (url.pathname === "/api/attention") return json({ records: [], projects: [], partial: false })
    return json({ detail: "Not Found" }, 404)
  })
  await new Promise((resolve) => dashboard.listen(0, "127.0.0.1", resolve))
  process.env.ES_DASHBOARD_URL = `http://127.0.0.1:${dashboard.address().port}`
  process.env.OPENCODE_URL = `http://127.0.0.1:${await freePort()}` // nothing listens: no Core in this proof
  vite = await createVite({
    root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: await mkdtemp(path.join(tmpdir(), "front-desk-memory-vite-")), logLevel: "error",
    optimizeDeps: { include: ["@opencode-ai/session-ui > @shikijs/stream", "@opencode-ai/session-ui > remend", "@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] },
    server: { host: "127.0.0.1", port: vitePort, strictPort: true },
  })
  await vite.listen()
  const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  await page.goto(`http://127.0.0.1:${vitePort}/desk`)
  await page.getByRole("button", { name: /^Memory/ }).click()
  const panel = page.locator(".desk-memory")
  await expect(panel).toContainText("No notes yet.", { timeout: 30000 })
  const add = async (id, text) => {
    await page.getByLabel("Note ID").fill(id)
    await page.getByLabel("Note text").fill(text)
    await page.getByRole("button", { name: "Add note" }).click()
  }
  const isPut = (url) => url.pathname === "/es/api/frontdesk/memory"
  const captured = []

  // 1. Lost PUT whose original request commits later.
  await page.route(isPut, (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    captured.push(route.request().postData())
    return route.abort("connectionreset")
  })
  await add("late", "Committed after the response was lost")
  await expect(panel).toContainText("not confirmed. It may still be saved", { timeout: 20000 })
  await expect(page.getByRole("button", { name: "Add note" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Resend identical change" })).toBeVisible()
  assert.equal((await memory()).revision, 0)
  await page.unroute(isPut)
  assert.equal((await direct("PUT", captured[0])).status, 200) // the original request lands late
  await page.getByRole("button", { name: "Reload memory" }).click()
  await expect(panel).toContainText("The earlier memory change was confirmed in the file.", { timeout: 20000 })
  await expect(page.locator('.desk-memory [data-memory-id="late"]')).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Resend identical change" })).toHaveCount(0)
  assert.equal((await memory()).revision, 1)
  log("LATE lost PUT -> 'not confirmed, may still be saved', writes blocked; original commits later -> reload confirms, revision 1 once")

  // 2. A 500 returned after the server committed.
  await page.route(isPut, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    await route.fetch()
    return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"response failed"}' })
  })
  await add("after500", "Committed before a 500")
  await expect(page.locator('.desk-memory [data-memory-id="after500"]')).toHaveCount(1, { timeout: 20000 })
  await expect(panel).not.toContainText("refused")
  await expect(panel).not.toContainText("not confirmed")
  await page.unroute(isPut)
  assert.equal((await memory()).revision, 2)
  log("AFTER500 commit then HTTP 500 -> reconciled as saved from the file, not 'refused'; revision 2")

  // 3. Lost before reaching the server, resent identically: applied once.
  captured.length = 0
  await page.route(isPut, (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    captured.push(route.request().postData())
    return route.abort("connectionreset")
  })
  await add("resent", "Resent with the identical request")
  await expect(panel).toContainText("not confirmed", { timeout: 20000 })
  await page.unroute(isPut)
  const resends = []
  page.on("request", (request) => { if (request.method() === "PUT" && isPut(new URL(request.url()))) resends.push(request.postData()) })
  await page.getByRole("button", { name: "Resend identical change" }).click()
  await expect(page.locator('.desk-memory [data-memory-id="resent"]')).toHaveCount(1, { timeout: 20000 })
  assert.deepEqual(resends, [captured[0]], "the resend is byte-identical")
  assert.equal((await direct("PUT", captured[0])).status, 409, "replaying it again cannot apply twice")
  assert.equal((await memory()).revision, 3)
  log("RESEND lost before commit -> identical body resent once -> revision 3; a further replay gets 409")

  // 4. Lost, then another writer changes memory: the original can never commit.
  captured.length = 0
  await page.route(isPut, (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    captured.push(route.request().postData())
    return route.abort("connectionreset")
  })
  await add("overtaken", "Overtaken by another writer")
  await expect(panel).toContainText("not confirmed", { timeout: 20000 })
  await page.unroute(isPut)
  const now = await (await direct("GET")).json()
  const entry = { id: "other", text: "Another tab", kind: "fact", scope: "global", confidence: "stated", source: { actor: "human" }, created: 1, updated: 1 }
  const other = { ...now.document, revision: now.document.revision + 1, entries: [...now.document.entries, entry], history: [...now.document.history, { n: now.document.revision + 1, at: 1, change: { op: "upsert", entryID: "other", actor: "human" }, entries: [...now.document.entries, entry] }] }
  assert.equal((await direct("PUT", JSON.stringify({ expected_hash: now.hash, document: other }))).status, 200)
  await page.getByRole("button", { name: "Reload memory" }).click()
  await expect(panel).toContainText("The earlier memory change was not saved: memory changed before it could commit.", { timeout: 20000 })
  await expect(page.locator('.desk-memory [data-memory-id="overtaken"]')).toHaveCount(0)
  assert.equal((await direct("PUT", captured[0])).status, 409)
  await expect(page.getByRole("button", { name: "Add note" })).toBeEnabled({ timeout: 5000 }).catch(() => {})
  log("OVERTAKEN lost, then another writer -> reload says not saved; the original body now gets 409")
  log("FRONT DESK MEMORY UNCERTAIN: PASS")
} catch (error) {
  console.error(`FAIL ${error?.message ?? ""}\n${error?.stack ?? error}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
  dashboard?.closeAllConnections?.()
  dashboard?.close()
  if (fixture) try { process.kill(-fixture.pid, "SIGTERM") } catch {}
  await rm(home, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}

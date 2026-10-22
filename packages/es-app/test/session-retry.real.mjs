// Run from packages/es-app: SESSION_RETRY_BINARY=/absolute/opencode node test/session-retry.real.mjs [--serve]
// Node, not Bun: the vite event mux's WebSocket upgrade does not complete under Bun's node:http.
// Private compiled Core, private HOME/DB, loopback stub provider (403/401 then success) and a stub
// dashboard. Never contacts a real model or the live daemon. --serve keeps the preview running.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import http from "node:http"
import net from "node:net"
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createServer as createVite } from "vite"
import { testProviderConfig } from "../../opencode/test/lib/test-provider.ts"

const serve = process.argv.includes("--serve")
const binary = process.env.SESSION_RETRY_BINARY
assert(binary && path.isAbsolute(binary), "SESSION_RETRY_BINARY must name an absolute compiled executable")
await access(binary, constants.X_OK)
const sha256 = createHash("sha256").update(await readFile(binary)).digest("hex")
const home = await mkdtemp(path.join(tmpdir(), "session-retry-real-"))
const project = path.join(home, "project a&b")
await mkdir(project, { recursive: true })
const db = path.join(home, "retry.sqlite")
const marker = path.join(home, "tool-runs.txt")
const evidence = process.env.SESSION_RETRY_EVIDENCE
const SECRET = "stub-provider-secret-9c1e"
const PROD_PORTS = [4096, 3181, 7777, 60302, 3100]
const log = (message) => console.log(message)
const bounded = (name, promise, ms = 20000) => {
  const deadline = Promise.withResolvers()
  const timer = setTimeout(() => deadline.reject(new Error(`${name} timed out in ${ms}ms`)), ms)
  return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer))
}
const poll = async (name, fn, ms = 30000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${name} timed out`)
}
const freePort = async () => {
  const probe = net.createServer()
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  assert(port > 1024 && !PROD_PORTS.includes(port), `refusing port ${port}`)
  return port
}
const listeners = (pid) => execFileSync("uv", ["run", "--with", "psutil", "python", "-c",
  "import psutil,sys; p=psutil.Process(int(sys.argv[1])); print(','.join(f'{c.laddr.ip}:{c.laddr.port}' for c in p.net_connections(kind='tcp') if c.status == 'LISTEN'))",
  String(pid)], { encoding: "utf8" }).trim()

// --- stub provider: OpenAI-compatible SSE, scripted per scenario marker in the first user prompt ---
const hits = {}
const holds = []
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
const text = (response, value) => {
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.write(chunk({ role: "assistant", content: value }))
  response.write(chunk({}, "stop"))
  response.end("data: [DONE]\n\n")
}
const fail = (response, status) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify({ error: { message: SECRET, type: "auth", code: String(status) } }))
}
const tool = (response, command, then) => {
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.write(chunk({ role: "assistant" }))
  response.write(chunk({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "bash", arguments: "" } }] }))
  response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command, description: "Record one tool run" }) } }] }))
  if (then === "error") return response.end(`data: ${JSON.stringify({ error: { message: SECRET, type: "invalid_request_error", code: "forbidden" } })}\n\n`)
  response.write(chunk({}, "tool_calls"))
  response.end("data: [DONE]\n\n")
}
const scripts = {
  tool403: [(r) => tool(r, `printf 'tool403\\n' >> '${marker}'`), (r) => fail(r, 403), (r) => text(r, "Recovered after the 403; the earlier tool result was reused.")],
  plain403: [(r) => fail(r, 403), (r) => text(r, "Recovered plain 403.")],
  again: [(r) => fail(r, 403), (r) => fail(r, 401), (r) => text(r, "Recovered on the third attempt.")],
  unsafe: [(r) => tool(r, `printf 'unsafe\\n' >> '${marker}'`, "error")],
  healthy: [(r) => text(r, "Healthy turn.")],
  race: [(r) => fail(r, 403), (r) => holds.push(() => text(r, "Recovered exactly once."))],
}
const provider = http.createServer(async (request, response) => {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString() || "{}")
  const raw = JSON.stringify(body)
  if (raw.includes("Generate a title")) return text(response, "Synthetic title")
  const scenario = Object.keys(scripts).find((name) => raw.includes(`SCENARIO:${name}:`))
  if (!scenario) return text(response, "Unscripted.")
  const count = hits[scenario] = (hits[scenario] ?? 0) + 1
  const step = scripts[scenario][count - 1]
  if (!step) return fail(response, 500)
  step(response)
})

// --- stub dashboard (/es): enough for the app shell; failure state comes only from Core ---
const dashboard = http.createServer((request, response) => {
  const url = new URL(request.url, "http://stub")
  const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)) }
  if (["/api/events", "/api/notification-events"].includes(url.pathname)) {
    response.writeHead(200, { "content-type": "text/event-stream" })
    return response.write("data: connected\n\n")
  }
  if (url.pathname === "/api/editspaces") return json({ editspaces: [{ name: "fixture", root: project }], default: "fixture" })
  if (url.pathname === "/api/state") return json({ editspace: "fixture", root: project, threads: [], attention: [], frontier: [], unattached_prs: [], sessions: [] })
  if (url.pathname === "/api/notifications") return json({ notifications: [] })
  if (url.pathname === "/api/handoffs") return json({ handoffs: [] })
  if (url.pathname === "/api/attention/session") return json({ operator: false })
  if (url.pathname === "/api/attention") return json({ records: [], projects: [], partial: false })
  return json({ detail: "Not Found" }, 404)
})

let child
let output = ""
let diagnostics = ""
let vite
let browser
let page
const corePort = await freePort()
const base = `http://127.0.0.1:${corePort}`
const startCore = async (label) => {
  output = ""
  child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(corePort)], {
    cwd: home,
    env: {
      ...process.env, HOME: home, OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`, XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`,
      OPENCODE_DB: db, OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: `${home}/config/opencode`,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`, OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...testProviderConfig(`http://127.0.0.1:${provider.address().port}/v1`),
        permission: { bash: "allow" },
        server: { hostname: "127.0.0.1", port: corePort, mdns: false },
      }),
      OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_SERVER_PASSWORD: "",
    }, stdio: ["ignore", "pipe", "pipe"],
  })
  child.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGKILL" ? 137 : 143))))
  const ready = Promise.withResolvers()
  void (async () => {
    for await (const piece of child.stdout) {
      output += new TextDecoder().decode(piece)
      const match = output.match(/listening on (http:\/\/[^\s]+)/)
      if (match) ready.resolve(match[1])
    }
    ready.reject(new Error("Core exited before ready"))
  })()
  void (async () => { for await (const piece of child.stderr) diagnostics += new TextDecoder().decode(piece) })()
  assert.equal(await bounded("Core listeningURL", ready.promise, 40000), base)
  const sockets = listeners(child.pid)
  assert(sockets.split(",").includes(`127.0.0.1:${corePort}`), sockets)
  assert.equal((await stat(db)).isFile(), true)
  log(`ISOLATION ${label} binary=${binary} sha256=${sha256} PID=${child.pid} url=${base} listen=${sockets} DB=${db} inode=${(await stat(db)).ino}`)
}
const stopCore = async () => {
  if (!child) return
  const pid = child.pid
  child.kill("SIGTERM")
  const exited = await bounded("Core exit", child.exited, 10000).catch(() => { child.kill("SIGKILL"); return child.exited })
  child = undefined
  await poll("Core listener gone", () => fetch(base).then(() => false, () => true), 10000)
  log(`STOPPED PID=${pid} exit=${exited}`)
}
const call = async (method, route, body, directory = project) => {
  const response = await bounded(`${method} ${route}`, fetch(`${base}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const raw = await response.text()
  return { status: response.status, raw, body: raw ? JSON.parse(raw) : undefined }
}
const failed = async () => (await call("GET", "/experimental/session/failed")).body
const messages = async (id) => (await call("GET", `/session/${id}/message`)).body
const runs = async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean)
const status = async (id) => (await call("GET", "/session/status")).body[id]?.type ?? "idle"
const settle = (id, label) => poll(`${label} settled`, async () => (await status(id)) === "idle" && (await messages(id)).at(-1)?.info.time?.completed)

const sessions = {}
const startScenario = async (name) => {
  const session = (await call("POST", "/session", { title: `Scenario ${name}`, agent: "build", model: { id: "test-model", providerID: "test" } })).body
  sessions[name] = session
  const sent = await call("POST", `/session/${session.id}/prompt_async`, {
    agent: "build", model: { providerID: "test", modelID: "test-model" },
    parts: [{ type: "text", text: `SCENARIO:${name}: run the scripted turn` }],
  })
  assert.equal(sent.status, 204, sent.raw)
  return session
}

try {
  await bounded("provider bind", new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve)))
  await bounded("dashboard bind", new Promise((resolve) => dashboard.listen(0, "127.0.0.1", resolve)))
  await startCore("initial")

  // 1. Reproduce: scripted mid-turn 403s, a failed-again chain, an unsafe failed step and a healthy turn.
  for (const name of ["tool403", "plain403", "again", "unsafe", "healthy", "race"]) await startScenario(name)
  for (const name of Object.keys(sessions)) await settle(sessions[name].id, name)
  const list = await failed()
  const byName = Object.fromEntries(Object.entries(sessions).map(([name, s]) => [name, list.find((item) => item.sessionID === s.id)]))
  assert.deepEqual(byName.tool403.error, { name: "APIError", statusCode: 403 })
  assert.equal(byName.tool403.retry, "available")
  assert.equal(byName.unsafe.retry, "unsafe")
  assert.equal(byName.healthy, undefined)
  assert.equal(JSON.stringify(list).includes(SECRET), false, "failure listing leaked provider text")
  // The unsafe step's tool call was cut off with the stream; whether it ran is unknowable to Core.
  const unsafeTool = (await messages(sessions.unsafe.id)).at(-1).parts.find((part) => part.type === "tool")
  assert(unsafeTool, "unsafe failed step should carry its tool part")
  assert.deepEqual(await runs(), ["tool403"])
  log(`REPRO unsafeToolState=${unsafeTool.state.status}`)
  log(`REPRO failed=${list.length} tool403=${byName.tool403.messageID} unsafe=${byName.unsafe.retry} healthy=excluded providerHits=${JSON.stringify(hits)} toolRuns=${(await runs()).length} secretInListing=false`)

  // 2. Durable across a Core process restart: identical listing from the new process.
  await stopCore()
  await startCore("restarted")
  assert.deepEqual(await failed(), list)
  log("PERSISTENCE listing identical after Core restart")

  // 3. Lost ACK / double click / single+bulk race: six concurrent retries of one failure, one provider turn.
  const race = byName.race
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => call("POST", `/session/${race.sessionID}/retry`, { messageID: race.messageID })))
  const accepted = outcomes.filter((item) => item.body.outcome === "accepted").length
  assert.equal(accepted, 1, JSON.stringify(outcomes.map((item) => item.body)))
  await poll("race provider call", () => hits.race === 2)
  const replay = await call("POST", `/session/${race.sessionID}/retry`, { messageID: race.messageID })
  assert.match(replay.body.outcome, /^(running|stale)$/)
  holds.splice(0).forEach((release) => release())
  await settle(race.sessionID, "race retry")
  assert.equal((await call("POST", `/session/${race.sessionID}/retry`, { messageID: race.messageID })).body.outcome, "stale")
  assert.equal(hits.race, 2)
  log(`RACE outcomes=${outcomes.map((item) => item.body.outcome).sort().join(",")} replayWhileRunning=${replay.body.outcome} providerHits=${hits.race}`)

  // 4. Unsafe: refused, provider untouched.
  assert.equal((await call("POST", `/session/${byName.unsafe.sessionID}/retry`, { messageID: byName.unsafe.messageID })).body.outcome, "unsafe")
  assert.equal(hits.unsafe, 1)

  // 5. Browser: red status, no bulk strip, per-session Retry (incl. failed-again), reload persistence, RTL, outage.
  const vitePort = await freePort()
  process.env.OPENCODE_URL = base
  process.env.ES_DASHBOARD_URL = `http://127.0.0.1:${dashboard.address().port}`
  const cache = await mkdtemp(path.join(tmpdir(), "session-retry-vite-"))
  vite = await createVite({
    root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: cache, logLevel: "warn",
    optimizeDeps: { include: ["@opencode-ai/session-ui > @shikijs/stream", "@opencode-ai/session-ui > remend", "@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] },
    server: { host: "127.0.0.1", port: vitePort, strictPort: true },
  })
  await vite.listen()
  const origin = `http://127.0.0.1:${vitePort}`
  const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.addInitScript(() => { if (!localStorage.getItem("es-app-all-projects")) localStorage.setItem("es-app-all-projects", "true") })
  page = await context.newPage()
  const posts = []
  page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname) })
  await page.goto(`${origin}/`)
  const row = (name) => page.locator(".sidebar .nav-item", { hasText: `Scenario ${name}` }).first()
  for (const name of ["tool403", "plain403", "again", "unsafe"])
    await expect(row(name).locator(".dot.failed")).toHaveAttribute("aria-label", /failed: Provider error|failed: Turn failed/)
  await expect(row("tool403").locator(".dot.failed")).toHaveAttribute("aria-label", "failed: Provider error 403 (forbidden)")
  await expect(row("healthy").locator(".dot.failed")).toHaveCount(0)
  await expect(row("race").locator(".dot.failed")).toHaveCount(0)
  await page.reload()
  await expect(row("plain403").locator(".dot.failed")).toHaveCount(1)
  assert.deepEqual(posts.filter((item) => item.endsWith("/retry")), [], "page load must not retry")
  // The sidebar offers no bulk retry; each failure is retried from its own session.
  await expect(page.locator(".sidebar")).not.toContainText(/Resume all|\d+ failed/)
  await expect(page.getByRole("button", { name: /Resume all/ })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Failed sessions" })).toHaveCount(0)
  if (evidence) await page.screenshot({ path: path.join(evidence, "01-failed-sidebar.png") })
  const retryFrom = async (name) => {
    await row(name).click()
    await page.locator(".session-work-status").getByRole("button", { name: /Retry failed turn/ }).click()
  }
  for (const name of ["tool403", "plain403", "again"]) await retryFrom(name)
  await poll("per-session provider calls", () => hits.tool403 === 3 && hits.plain403 === 2 && hits.again === 2)
  for (const name of ["tool403", "plain403", "again"]) await settle(sessions[name].id, `${name} retry`)
  await expect(row("tool403").locator(".dot.failed")).toHaveCount(0, { timeout: 20000 })
  await expect(row("plain403").locator(".dot.failed")).toHaveCount(0)
  await expect(row("again").locator(".dot.failed")).toHaveAttribute("aria-label", "failed: Provider error 401 (unauthorized)", { timeout: 20000 })
  await expect(row("unsafe").locator(".dot.failed")).toHaveCount(1)
  assert.equal(posts.filter((item) => item.endsWith("/retry")).length, 3)
  assert.deepEqual(await runs(), ["tool403"], "completed tools must not rerun")
  const recovered = await messages(sessions.tool403.id)
  assert.equal(recovered.filter((message) => message.info.role === "user").length, 1, "no fabricated prompt")
  if (evidence) await page.screenshot({ path: path.join(evidence, "02-after-retries.png") })
  log(`RETRIES posts=3 hits=${JSON.stringify(hits)} toolRuns=${(await runs()).join(",")} users(tool403)=1 again=red(401)`)

  await row("again").click()
  const retry = page.locator(".session-work-status").getByRole("button", { name: /Retry failed turn/ })
  await expect(page.locator(".session-work-status")).toContainText("Session failed")
  await expect(retry).toBeVisible()
  if (evidence) await page.screenshot({ path: path.join(evidence, "03-session-retry.png") })
  await retry.dblclick()
  await poll("again third call", () => hits.again === 3)
  await settle(sessions.again.id, "again single")
  await expect(page.locator(".session-work-status")).not.toContainText("Session failed", { timeout: 20000 })
  await expect(row("again").locator(".dot.failed")).toHaveCount(0)
  assert.equal(posts.filter((item) => item.endsWith("/retry")).length, 4, "double click sends one retry")
  assert.equal(hits.again, 3)

  await row("unsafe").click()
  await expect(page.locator(".session-work-status")).toContainText("Retry unavailable: the failed step ran tools")
  await expect(page.locator(".session-work-status").getByRole("button", { name: /Retry/ })).toHaveCount(0)

  await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
  await page.goto(`${origin}/`)
  await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
  await expect(row("unsafe").locator(".dot.failed")).toHaveCount(1)
  await expect(page.getByRole("button", { name: /Resume all/ })).toHaveCount(0)
  if (evidence) await page.screenshot({ path: path.join(evidence, "04-rtl-unsafe-only.png") })
  await page.evaluate(() => document.documentElement.setAttribute("dir", "ltr"))

  // An outage on the very first read is reported, not shown as "nothing failed".
  const outage = await context.newPage()
  await outage.route("**/oc/experimental/session/failed", (route) => route.fulfill({ status: 503, body: "unavailable" }))
  await outage.goto(`${origin}/`)
  // With the strip gone an outage adds no sidebar chrome; no row is marked failed on a guess.
  await expect(outage.locator(".sidebar .dot.failed")).toHaveCount(0)
  await expect(outage.getByRole("button", { name: /Resume all/ })).toHaveCount(0)
  if (evidence) await outage.screenshot({ path: path.join(evidence, "05-status-unavailable.png") })
  await outage.close()
  log(`BROWSER PASS dots/reload/no-auto-retry/no-bulk/per-session/failed-again/single-dblclick/unsafe/RTL/outage posts=${posts.filter((item) => item.endsWith("/retry")).length}`)
  log(`PROVIDER hits=${JSON.stringify(hits)} toolRuns=${(await runs()).join(",")}`)

  if (serve) {
    // Leave one fresh failure for the reviewer to retry by hand.
    scripts.plain403.push((r) => fail(r, 403), (r) => text(r, "Recovered by the reviewer."))
    await call("POST", `/session/${sessions.plain403.id}/prompt_async`, {
      agent: "build", model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: "SCENARIO:plain403: again please" }],
    })
    log(`PREVIEW ${origin}/  (All projects view)\nCORE ${base} PID=${child.pid} DB=${db}\nSTOP kill ${process.pid}`)
    await browser.close()
    browser = undefined
    await new Promise((resolve) => { process.on("SIGTERM", resolve); process.on("SIGINT", resolve) })
  }
  log("SESSION RETRY REAL: PASS")
} catch (error) {
  if (page && evidence) await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => {})
  console.error(`FAIL ${error?.message ?? ""}\n${error?.stack ?? error}\n--- core stdout tail\n${output.slice(-2000)}\n--- core stderr tail\n${diagnostics.slice(-3000)}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
  await stopCore().catch(() => {})
  await new Promise((resolve) => provider.close(resolve))
  dashboard.closeAllConnections?.()
  await new Promise((resolve) => dashboard.close(resolve))
  if (!serve || process.exitCode) await rm(home, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}

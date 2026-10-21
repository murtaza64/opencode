// Home permission replies and TODO lines against a private real OpenCode runtime.
// Private HOME/DB/config, loopback fake provider; never contacts a real model or the live daemon.
// Run from packages/es-app: HOME_AGENTS_BINARY=/abs/opencode node test/home-agents.real.mjs
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import http from "node:http"
import net from "node:net"
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const binary = process.env.HOME_AGENTS_BINARY
assert(binary && path.isAbsolute(binary), "HOME_AGENTS_BINARY must be an absolute executable")
await access(binary, constants.X_OK)
const sha256 = createHash("sha256").update(await readFile(binary)).digest("hex")
const artifacts = process.env.HOME_AGENTS_ARTIFACTS ?? tmpdir()
const home = await mkdtemp(path.join(tmpdir(), "home-agents-real-"))
const project = path.join(home, "project")
await mkdir(project, { recursive: true })
await writeFile(path.join(project, "README.md"), "private fixture\n")
const db = path.join(home, "opencode.sqlite")
const log = []
const record = (line) => { log.push(line); console.log(line) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const poll = async (name, fn, ms = 30_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw Error(`${name} timed out`)
}
const freePort = async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  assert(![4096, 3181, 7777, 60302, 3100].includes(port))
  return port
}

// Fake provider: per session transcript, 0 tool results -> todowrite, 1 -> bash, then text.
const providerCalls = []
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const provider = http.createServer(async (request, response) => {
  const chunks = []
  for await (const piece of request) chunks.push(piece)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  providerCalls.push(body)
  const marker = JSON.stringify(body.messages).match(/HOME-AGENTS-(\w+)/)?.[1] ?? "X"
  const tools = body.messages.filter((message) => message.role === "tool").length
  response.writeHead(200, { "content-type": "text/event-stream" })
  const call = (name, args) => {
    response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${marker}_${tools}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }))
    response.write(chunk({}, "tool_calls"))
  }
  if (tools === 0) call("todowrite", { todos: [{ content: `Private real todo ${marker}`, status: "in_progress", priority: "high" }, { content: "Report", status: "pending", priority: "low" }] })
  else if (tools === 1) call("bash", { command: `echo home-agents-real-${marker}`, description: `Synthetic command ${marker}` })
  else { response.write(chunk({ role: "assistant", content: "synthetic done" })); response.write(chunk({}, "stop")) }
  response.end("data: [DONE]\n\n")
})
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))

let runtime
let preview
let browser
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { try { process.kill(-runtime.pid, "SIGKILL") } catch {} process.exit(130) })
try {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const config = { formatter: false, lsp: false, server: { hostname: "127.0.0.1", port, mdns: false }, provider: { test: { name: "Test", id: "test", env: [], npm: "@ai-sdk/openai-compatible",
    models: { "test-model": { id: "test-model", name: "Test Model", attachment: false, reasoning: false, temperature: false, tool_call: true, release_date: "2025-01-01", limit: { context: 100_000, output: 10_000 }, cost: { input: 0, output: 0 }, options: {} } },
    options: { apiKey: "test-key", baseURL: `http://127.0.0.1:${provider.address().port}/v1` } } } }
  runtime = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: home, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`,
    XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`, OPENCODE_DB: db, OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: `${home}/config/opencode`, OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`, OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true", OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_PERMISSION: JSON.stringify({ bash: "ask" }),
  } })
  let runtimeOut = ""
  runtime.stdout.on("data", (data) => { runtimeOut += data })
  runtime.stderr.on("data", (data) => { runtimeOut += data })
  assert.equal(await poll("runtime listening", () => runtimeOut.match(/listening on (http:\/\/[^\s]+)/)?.[1]), base)
  const owner = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")
  assert(owner.includes(String(runtime.pid)), `listener ${owner} is not runtime ${runtime.pid}`)
  assert((await stat(db)).isFile())
  record(`ISOLATION binary=${binary} sha256=${sha256} pid=${runtime.pid} url=${base} db=${db}`)
  const api = async (method, route, body) => {
    const response = await fetch(`${base}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, {
      method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const sessionA = (await api("POST", "/session", { title: "Private agent A", agent: "build", model: { id: "test-model", providerID: "test" } })).body
  const sessionB = (await api("POST", "/session", { title: "Private agent B", agent: "build", model: { id: "test-model", providerID: "test" } })).body
  // The real reply contract for an unknown request is a typed 404.
  const unknown = await api("POST", "/permission/per_unknown_home/reply", { reply: "once" })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body._tag, "PermissionNotFoundError")
  record(`CONTRACT unknown reply -> ${unknown.status} ${unknown.body._tag}`)

  // /oc requests and event streams go to the private runtime; /es stays the disposable fixture.
  preview = await startPanelPreview([], 0, { opencode: base })
  const started = Date.now()
  preview.fixture.currentWork = () => ({ turn: { started_at: started, elapsed_seconds: 1, status: "busy", user_messages: 1, assistant_messages: 1, tool_calls: 1, active_tools: [], watermark: "real" }, summary: { status: "unavailable", text: null, generated_at: null, watermark: null } })
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await context.addInitScript(([directory, id]) => {
    localStorage.setItem("es-app-all-projects", "true")
    localStorage.setItem("es-app-sidebar-pins", JSON.stringify([JSON.stringify([directory, id])]))
  }, [project, sessionA.id])
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  const replies = []
  page.on("request", (request) => { if (/\/oc\/permission\/[^/]+\/reply/.test(request.url())) replies.push(`${request.url()} ${request.postData()}`) })
  await page.goto(preview.origin, { waitUntil: "domcontentloaded" })
  const todoLine = page.getByRole("region", { name: "Pinned agents" }).locator(".home-todo")
  await expect(todoLine).toContainText("No TODO list", { timeout: 90_000 })

  // Record the runtime's own global stream for evidence of what the app can observe.
  const globalEvents = []
  const stream = new AbortController()
  void fetch(`${base}/global/event`, { signal: stream.signal }).then(async (response) => {
    const decoder = new TextDecoder()
    for await (const piece of response.body) for (const line of decoder.decode(piece).split("\n")) if (line.startsWith("data: ")) {
      try { const value = JSON.parse(line.slice(6)); globalEvents.push({ directory: value.directory, type: value.payload?.type, sessionID: value.payload?.properties?.sessionID }) } catch {}
    }
  }).catch(() => undefined)
  await sleep(500)
  for (const [session, marker] of [[sessionA, "A"], [sessionB, "B"]])
    assert.equal((await api("POST", `/session/${session.id}/prompt_async`, { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: `HOME-AGENTS-${marker} synthetic task` }] })).status, 204)
  const pending = await poll("both permissions pending", async () => { const list = (await api("GET", "/permission")).body; return list.length === 2 && list })
  const permA = pending.find((item) => item.sessionID === sessionA.id)
  const permB = pending.find((item) => item.sessionID === sessionB.id)
  record(`PENDING A=${permA.id} B=${permB.id} patterns=${JSON.stringify(permA.patterns)}`)

  await sleep(1000)
  record(`GLOBAL ${JSON.stringify(globalEvents.filter((event) => /^(todo|permission)\./.test(event.type ?? "")))}`)
  // Live todo.updated from the real todowrite tool reaches the pinned row.
  await expect(todoLine).toContainText("Private real todo A", { timeout: 15_000 })
  await expect(todoLine).toContainText("0/2 · update observed this turn")
  record("TODO pinned row shows real todowrite list via todo.updated (observed this turn)")

  const cardA = page.locator(`.home-permission[data-request-id="${permA.id}"]`)
  const cardB = page.locator(`.home-permission[data-request-id="${permB.id}"]`)
  await expect(cardA).toContainText("echo home-agents-real-A", { timeout: 30_000 })
  await expect(cardA).toContainText(`session ${sessionA.id}`)
  await expect(cardB).toContainText("echo home-agents-real-B")
  await page.screenshot({ path: path.join(artifacts, "home-agents-real.png"), fullPage: true })

  // Allow once on A only: A's command runs; B stays pending in the runtime.
  await cardA.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(page.locator(".home-receipts")).toContainText("Allowed once · bash · Private agent A")
  await expect(cardA).toHaveCount(0)
  const remaining = (await api("GET", "/permission")).body
  assert.deepEqual(remaining.map((item) => item.id), [permB.id])
  const ran = await poll("A command output", async () => {
    const messages = (await api("GET", `/session/${sessionA.id}/message`)).body
    return messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "completed")
  })
  assert.match(ran.state.output, /home-agents-real-A/)
  record(`ONCE ${permA.id} -> bash completed output=${JSON.stringify(ran.state.output.trim())}; B still pending`)

  // Double-click reject on B sends one reply; B's tool is rejected.
  await cardB.getByRole("button", { name: "Reject", exact: true }).dblclick()
  await expect(page.locator(".home-receipts li").first()).toContainText("Rejected · bash · Private agent B")
  assert.deepEqual((await api("GET", "/permission")).body, [])
  const rejected = await poll("B rejected", async () => {
    const messages = (await api("GET", `/session/${sessionB.id}/message`)).body
    return messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "bash" && part.state.status === "error")
  })
  assert.equal(replies.filter((line) => line.includes(permB.id)).length, 1)
  assert.equal(replies.length, 2)
  record(`REJECT ${permB.id} single POST (dblclick) -> bash error=${JSON.stringify(rejected.state.error.slice(0, 80))}`)
  // Replaying the settled request through the real contract is a 404, which Home renders as not applied.
  const stale = await api("POST", `/permission/${permB.id}/reply`, { reply: "once" })
  assert.equal(stale.status, 404)
  record(`STALE settled ${permB.id} replay -> ${stale.status}`)
  record("PASS real private runtime: exact once/reject from Home, single send, typed 404, live todo.updated projection")
} catch (error) {
  record(`FAIL ${error.stack ?? error}`)
  process.exitCode = 1
} finally {
  await browser?.close()
  await preview?.close()
  if (runtime) {
    try { process.kill(-runtime.pid, "SIGTERM") } catch {}
    await Promise.race([new Promise((resolve) => runtime.exitCode !== null ? resolve() : runtime.once("exit", resolve)), sleep(5000)])
    try { process.kill(-runtime.pid, "SIGKILL") } catch {}
  }
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  const result = path.join(artifacts, `home-agents-real-${process.pid}.log`)
  await writeFile(result, log.join("\n") + "\n")
  if (!process.env.HOME_AGENTS_KEEP) await rm(home, { recursive: true, force: true })
  console.log(`RESULT ${result}`)
}

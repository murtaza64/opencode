// Run from packages/es-app: FRONT_DESK_BINARY=/absolute/opencode node test/front-desk.real.mjs [--serve]
// Private compiled Core (free port, private HOME/DB), loopback stub provider and stub dashboard,
// headless Chrome. Never contacts a real model, the live daemon, or a live attention ledger.
// Covers: expanded chat with nothing selected, exact draft + transcript across select/close/reload,
// a held background brief overlapping another chat exchange, late result bound to its initiating
// revision, stale-revision discard, and no automatic rerun after a Core restart.
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
import { fileURLToPath } from "node:url"
import { createServer as createVite } from "vite"
import { testProviderConfig } from "../../opencode/test/lib/test-provider.ts"

const serve = process.argv.includes("--serve")
const binary = process.env.FRONT_DESK_BINARY
assert(binary && path.isAbsolute(binary), "FRONT_DESK_BINARY must name an absolute compiled executable")
await access(binary, constants.X_OK)
const sha256 = createHash("sha256").update(await readFile(binary)).digest("hex")
const home = await mkdtemp(path.join(tmpdir(), "front-desk-real-"))
const project = path.join(home, "project")
await mkdir(project, { recursive: true })
const db = path.join(home, "desk.sqlite")
const evidence = process.env.FRONT_DESK_EVIDENCE
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

// --- stub provider: OpenAI-compatible SSE ---
const hits = { chat: 0, brief: 0, source: 0 }
const seen = { chat: [], briefTools: [], memory: {}, retrieved: [], models: { chat: [], brief: [] } }
const holds = []
let holdBriefs = true
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
const text = (response, value) => {
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.write(chunk({ role: "assistant", content: value }))
  response.write(chunk({}, "stop"))
  response.end("data: [DONE]\n\n")
}
const tool = (response, name, input) => {
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.write(chunk({ role: "assistant" }))
  response.write(chunk({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }))
  response.write(chunk({}, "tool_calls"))
  response.end("data: [DONE]\n\n")
}
const lastUser = (body) => {
  const message = (body.messages ?? []).findLast((item) => item.role === "user")
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => part.text ?? "").join("\n")
}
const provider = http.createServer(async (request, response) => {
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString() || "{}")
  const raw = JSON.stringify(body)
  if (raw.includes("Generate a title")) return text(response, "Synthetic title")
  const user = lastUser(body)
  if (user.includes("Prepare an evidence brief")) {
    hits.brief++
    // Jobs the test itself posts directly (revision 0) are not the app's.
    if (!user.includes("source revision: 0")) seen.models.brief.push(body.model)
    seen.briefTools.push((body.tools ?? []).map((tool) => tool.function?.name).sort())
    const revision = /source revision: (\S+)/.exec(user)?.[1]
    // Automatic briefs (revision 6+) first retrieve local context with a read-only tool.
    if (Number(revision) >= 6 && !raw.includes('"role":"tool"')) return tool(response, "read", { filePath: path.join(project, "ROLLOUT.md") })
    if (Number(revision) >= 6) seen.retrieved.push(raw.includes("canary owner is Kim"))
    const reply = () => text(response, JSON.stringify({
      question: "Choose whether to stay at the canary or roll out fully",
      context: "The canary has been healthy for a day; full rollout reaches every user at once.",
      choices: [{ id: "canary", outcome: `Traffic stays at 5% while you watch errors (rev ${revision})`, note: "Slower" }, { id: "full", outcome: "All traffic moves now" }],
      sources: [{ label: "Canary deploy note", refs: ["E2"] }],
      ifWait: "",
      shape: { kind: "sequence", steps: ["build", "canary 5%", "decide"] },
      gaps: ["Who owns the full rollout is not stated"],
      facts: [{ text: "Canary serves 5% of traffic", refs: ["E2"] }, { text: "Invented claim", refs: ["E99"] }],
      timeline: [{ when: "10:00", text: "Canary deployed", refs: ["E2"] }],
      // Automatic briefs draw their own picture instead of a shape.
      ...(Number(revision) >= 6 ? {
        shape: undefined,
        facts: [{ text: "Kim owns the canary", refs: ["file:ROLLOUT.md"] }],
        visual: { title: "Canary versus full rollout", height: 160, html: '<table id="cmp"><tr><th></th><th>Stay at canary</th><th>Full rollout</th></tr><tr><td>Traffic</td><td>5%</td><td>100%</td></tr></table><img src="https://example.invalid/x.png"><script>document.body.dataset.ran="yes"</script>' },
      } : {}),
    }))
    return holdBriefs ? holds.push(reply) : reply()
  }
  // A More detail request quotes the source thread, which itself contains "SOURCE:"; the desk question wins.
  if (user.includes("SOURCE:") && !/DESK-[QM]\d/.test(user)) { hits.source++; return text(response, "Canary deployed to 5% at 10:00; error rate flat.") }
  const question = /DESK-[QM]\d/.exec(user)?.[0]
  if (question) {
    hits.chat++
    seen.models.chat.push([question, body.model])
    // The newest generated context note is the one that describes this exchange.
    // Only this exchange's own message counts: context must ride with the send it informs.
    const own = JSON.stringify((body.messages ?? []).findLast((item) => item.role === "user" && JSON.stringify(item.content).includes(question)) ?? "")
    const note = own.includes("Front desk context from es-app") ? own : ""
    seen.chat.push({ question, context: !!note, none: note.includes("selected item: none"), selected: note.includes("selected item (the human is looking at this now)") && note.includes("Pick a rollout"), ledgerDown: note.includes("Attention ledger: unavailable") })
    seen.memory[question] = [/memory \(revision (\d+)/.exec(own)?.[1], own.includes("Works in UTC") ? "tz" : own.includes("Reviews in the morning") ? "morning" : undefined]
    if (question === "DESK-M1") return text(response, 'Noted.\n```front-desk-memory\n{"op":"upsert","id":"tz","text":"Works in UTC","kind":"preference"}\n{"op":"upsert","id":"key","text":"api_key = sk-test-abcdef1234567890"}\n```')
    return text(response, `Desk answer for ${question}.`)
  }
  return text(response, "Unscripted.")
})

// --- stub dashboard (/es): editspace registry and a read-only attention ledger ---
let attentionRevision = 1
let attentionDown = false
let sourceSession = ""
const attentionPosts = []
const record = () => ({
  id: "att_rollout", editspace: "fixture", revision: attentionRevision, status: "open", kind: "decision", lane: null,
  title: "Pick a rollout", context: "The canary is healthy. Choose how far to roll out.",
  options: [{ id: "canary", label: "Stay at canary" }, { id: "full", label: "Full rollout" }], recommendation: "canary",
  producer_session: sourceSession, origin_session: sourceSession, gate_key: "rollout",
  source_ref: { session_id: sourceSession, directory: project }, decision: null, delivery_state: "not-requested", answer: null, delivery: null,
  created_at: Date.now() - 60_000, updated_at: Date.now(),
})
// Extra open decisions for the backlog proof, newest last.
const extraRecords = []
const extraRecord = (n) => ({ ...record(), id: `att_extra_${n}`, revision: 1, title: `Backlog decision ${n}`, gate_key: `extra-${n}`, created_at: Date.now() - 50_000 + n * 1000 })
// Memory and, once enabled, the operator session go to the real dotfiles seam (private HOME).
let operatorReal = false
let memoryBase = ""
let operatorToken = ""
const forward = async (request, response, url) => {
  const target = new URL(url.pathname + url.search, memoryBase)
  const headers = Object.fromEntries(["cookie", "content-type", "x-attention-csrf", "origin", "authorization", "sec-fetch-site"].flatMap((name) => request.headers[name] ? [[name, request.headers[name]]] : []))
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(await Array.fromAsync(request))
  const result = await fetch(target, { method: request.method, headers, body })
  const out = { "content-type": result.headers.get("content-type") ?? "application/json" }
  const cookie = result.headers.get("set-cookie")
  if (cookie) out["set-cookie"] = cookie
  response.writeHead(result.status, out)
  response.end(Buffer.from(await result.arrayBuffer()))
}
const dashboard = http.createServer((request, response) => {
  const url = new URL(request.url, "http://stub")
  if (url.pathname === "/api/frontdesk/memory" || (operatorReal && url.pathname === "/api/attention/session"))
    return void forward(request, response, url).catch(() => { response.writeHead(502); response.end() })
  const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)) }
  if (["/api/events", "/api/notification-events"].includes(url.pathname)) {
    response.writeHead(200, { "content-type": "text/event-stream" })
    return response.write("data: connected\n\n")
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/attention/") && url.pathname !== "/api/attention/session") attentionPosts.push(url.pathname)
  if (url.pathname === "/api/editspaces") return json({ editspaces: [{ name: "fixture", root: project }], default: "fixture" })
  if (url.pathname === "/api/state") return json({ editspace: "fixture", root: project, threads: [], attention: [], frontier: [], unattached_prs: [], sessions: [] })
  if (url.pathname === "/api/notifications") return json({ notifications: [] })
  if (url.pathname === "/api/handoffs") return json({ handoffs: [] })
  if (url.pathname === "/api/mail") return json({ editspace: "fixture", lane: "", messages: [] })
  if (url.pathname === "/api/attention/session") return json({ operator: false })
  if (url.pathname === "/api/attention" && attentionDown) return json({ detail: "down" }, 503)
  if (url.pathname === "/api/attention") return json({ records: sourceSession ? [record(), ...extraRecords] : [], projects: [{ editspace: "fixture", available: true }], partial: false })
  return json({ detail: "Not Found" }, 404)
})

let child
let output = ""
let diagnostics = ""
let vite
let memoryFixture
let browser
let page
const corePort = await freePort()
const base = `http://127.0.0.1:${corePort}`
// The real provider and model names, served by the same fake endpoint, so model selection is observable.
const deskProviders = (url) => {
  const config = testProviderConfig(url)
  const named = (id, model) => ({ ...config.provider.test, id, name: id, models: { [model]: { ...config.provider.test.models["test-model"], id: model, name: model } } })
  return { ...config, provider: { ...config.provider, "duolingo-openai": named("duolingo-openai", "gpt-6.1-sol"), "duolingo-anthropic": named("duolingo-anthropic", "claude-fable-5") } }
}
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
        ...deskProviders(`http://127.0.0.1:${provider.address().port}/v1`),
        model: "test/test-model",
        small_model: "test/test-model",
        // Like the real agent before the fix: its own default is another model.
        agent: { "front-desk": { mode: "primary", description: "Stub front desk", prompt: "You are the stub front desk.", model: "duolingo-anthropic/claude-fable-5" } },
        server: { hostname: "127.0.0.1", port: corePort, mdns: false },
      }),
      OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_SERVER_PASSWORD: "",
    }, stdio: ["ignore", "pipe", "pipe"],
  })
  const owned = child
  // Last resort: never leave the private Core running if this script exits early.
  process.once("exit", () => { if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL") })
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
const call = async (method, route, body) => {
  const response = await bounded(`${method} ${route}`, fetch(`${base}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const raw = await response.text()
  return { status: response.status, raw, body: raw ? JSON.parse(raw) : undefined }
}
const messages = async (id) => (await call("GET", `/session/${id}/message`)).body
const status = async (id) => (await call("GET", "/session/status")).body[id]?.type ?? "idle"

try {
  await bounded("provider bind", new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve)))
  await bounded("dashboard bind", new Promise((resolve) => dashboard.listen(0, "127.0.0.1", resolve)))
  await startCore("initial")

  // Source thread the attention record points at; its transcript is the brief's evidence.
  const source = (await call("POST", "/session", { title: "Rollout agent" })).body
  assert.equal((await call("POST", `/session/${source.id}/prompt_async`, { parts: [{ type: "text", text: "SOURCE: report the canary" }] })).status, 204)
  await poll("source settled", async () => (await status(source.id)) === "idle" && (await messages(source.id)).at(-1)?.info.time?.completed)
  sourceSession = source.id

  const vitePort = await freePort()
  const dotfiles = process.env.FRONT_DESK_DOTFILES
  assert(dotfiles && path.isAbsolute(dotfiles), "FRONT_DESK_DOTFILES must name the dotfiles checkout with bin/es_dashboard_memory.py")
  memoryFixture = spawn("uv", ["run", "--quiet", path.join(dotfiles, "tests/frontdesk_memory_fixture.py"), "--origin", `http://127.0.0.1:${vitePort}`], {
    env: { ...process.env, HOME: home, ES_ATTENTION_AUTH_FILE: path.join(home, "attention.key") }, stdio: ["ignore", "pipe", "pipe"], detached: true,
  })
  const fixtureProcess = memoryFixture
  process.once("exit", () => { if (fixtureProcess.exitCode === null) try { process.kill(-fixtureProcess.pid, "SIGKILL") } catch {} })
  let fixtureOut = ""
  memoryBase = await bounded("memory fixture", new Promise((resolve, reject) => {
    memoryFixture.stdout.on("data", (piece) => { fixtureOut += piece; const match = /listening on (http:\/\/\S+) file=(\S+)/.exec(fixtureOut); if (match) resolve(match[1]) })
    memoryFixture.stderr.on("data", (piece) => { fixtureOut += piece })
    memoryFixture.once("exit", (code) => reject(new Error(`memory fixture exited ${code}: ${fixtureOut}`)))
  }), 60000)
  assert(fixtureOut.includes(`file=${path.join(home, ".local/share/opencode/front-desk/memory.json")}`), fixtureOut)
  operatorToken = execFileSync("uv", ["run", "--quiet", "python", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import es_attention_auth as a; print(a.mint({'role':'operator','purpose':'api','es':'*','channel':'ui'}))", path.join(dotfiles, "bin")],
    { env: { ...process.env, HOME: home, ES_ATTENTION_AUTH_FILE: path.join(home, "attention.key") }, encoding: "utf8" }).trim()
  log(`MEMORYSEAM real dotfiles fixture ${memoryBase} HOME=${home} PID=${memoryFixture.pid}`)
  process.env.OPENCODE_URL = base
  process.env.ES_DASHBOARD_URL = `http://127.0.0.1:${dashboard.address().port}`
  const cache = await mkdtemp(path.join(tmpdir(), "front-desk-vite-"))
  vite = await createVite({
    root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: cache, logLevel: "warn",
    optimizeDeps: { include: ["@opencode-ai/session-ui > @shikijs/stream", "@opencode-ai/session-ui > remend", "@opencode-ai/ui > @shikijs/stream", "@opencode-ai/ui > remend"] },
    server: { host: "127.0.0.1", port: vitePort, strictPort: true },
  })
  await vite.listen()
  const origin = `http://127.0.0.1:${vitePort}`
  const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  // Vite compiles on first load; a loaded machine can take well over the default 30s.
  page.setDefaultNavigationTimeout(120_000)
  const posts = []
  page.on("request", (request) => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname) })
  const editor = () => page.locator(".desk-chat .prompt-box textarea")
  const transcript = () => page.locator(".desk-chat .transcript")
  // Plain sends only: wait until Core reports the desk session idle, so nothing becomes a steer.
  const sendIdle = async () => {
    await poll("desk idle", async () => !pointerID || (await status(pointerID)) === "idle")
    // The header may read busy while a brief child runs; the desk session itself must be idle.
    await expect(page.locator(".desk-chat .session-state")).not.toHaveText(/disconnected|failed/, { timeout: 20000 })
    await expect(page.locator(".desk-chat").getByRole("button", { name: /^Send/ })).toBeEnabled({ timeout: 20000 })
    await editor().press("Control+Enter")
  }
  let pointerID

  // 1. Expanded chat with nothing selected; the queue aggregates the ledger with freshness.
  await page.goto(`${origin}/`)
  await expect(page.locator(".desk-item")).toHaveCount(1, { timeout: 20000 })
  await expect(page.locator(".desk-evidence")).toHaveCount(0)
  await expect(page.locator(".desk-source", { hasText: "Attention ledger" })).toContainText("read-only: operator connection unavailable")
  // Root conversation identity: a lost create never yields a second conversation.
  const rootCreate = (request) => request.method() === "POST" && new URL(request.url()).pathname === "/oc/session" && !JSON.parse(request.postData() || "{}").parentID
  const sessionRoute = (url) => url.pathname === "/oc/session"
  const deskSessions = async () => (await call("GET", "/session")).body.filter((item) => item.title === "Front desk")
  await page.route(sessionRoute, (route) => rootCreate(route.request()) ? route.abort("connectionreset") : route.fallback())
  await page.getByRole("button", { name: "Start chat" }).click()
  await expect(page.locator(".desk-start")).toContainText("start not confirmed", { timeout: 20000 })
  const unconfirmed = JSON.parse(await page.evaluate(() => localStorage.getItem("es-app:front-desk:1")))
  assert.equal((await deskSessions()).length, 0)
  await page.reload()
  await expect(page.locator(".desk-start")).toContainText("start not confirmed", { timeout: 20000 })
  await expect(page.getByRole("button", { name: "Start chat" })).toHaveCount(0)
  await page.unroute(sessionRoute)
  let rootPosts = 0
  await page.route(sessionRoute, async (route) => {
    if (!rootCreate(route.request())) return route.fallback()
    rootPosts++
    await route.fetch()
    return route.abort("connectionreset")
  })
  await page.getByRole("button", { name: "Confirm start" }).click()
  await poll("root desk created", async () => (await deskSessions()).length === 1)
  await expect(page.locator(".desk-start")).toContainText("start not confirmed", { timeout: 20000 })
  await page.unroute(sessionRoute)
  await page.reload()
  await expect(editor()).toBeVisible({ timeout: 20000 })
  const pointer = JSON.parse(await page.evaluate(() => localStorage.getItem("es-app:front-desk:1")))
  pointerID = pointer.session
  assert.equal(pointer.session, unconfirmed.session)
  assert.equal(pointer.create, undefined)
  assert.deepEqual((await deskSessions()).map((item) => item.id), [unconfirmed.session])
  assert.equal(rootPosts, 1)
  log(`ROOTLOSTACK ${unconfirmed.session}: lost before Core -> unconfirmed across reload; confirmed once (response lost) -> adopted on reload; deskSessions=1`)
  const briefAnchor = `ses_fdbrief_${createHash("sha256").update(project).digest("hex").slice(0, 20)}`
  const deskInfo = (await call("GET", `/session/${pointer.session}`)).body
  assert.equal(deskInfo.agent, "front-desk")
  // Created on the desk model explicitly, not the agent's own default.
  assert.deepEqual([deskInfo.model?.providerID, deskInfo.model?.id], ["duolingo-openai", "gpt-6.1-sol"])
  assert.deepEqual(deskInfo.permission, [{ permission: "edit", pattern: "*", action: "deny" }])
  log(`DESK session=${pointer.session} agent=${deskInfo.agent} permission=${JSON.stringify(deskInfo.permission)}`)

  await editor().fill("DESK-Q1 what is waiting?")
  await sendIdle()
  await expect(transcript()).toContainText("Desk answer for DESK-Q1.", { timeout: 20000 })
  assert.deepEqual(seen.chat[0], { question: "DESK-Q1", context: true, none: true, selected: false, ledgerDown: false })
  // Context rides inside the human's own message as a marked synthetic part; no separate turn.
  const q1 = (await messages(pointer.session)).filter((item) => item.info.role === "user")
  assert.equal(q1.length, 1, "one user message for one send")
  assert.deepEqual(q1[0].parts.map((part) => [part.type, part.synthetic ?? false, part.metadata?.source ?? null]),
    [["text", false, null], ["text", true, "es-app/front-desk"]])
  assert.equal(q1[0].parts[0].text, "DESK-Q1 what is waiting?")
  await expect(transcript()).not.toContainText("Front desk context")
  log(`CONTEXT one user message ${q1[0].info.id}: human text + synthetic part source=es-app/front-desk`)

  // Context refreshes on the next send when the queue or source health changes, and only then.
  await editor().fill("DESK-Q3 anything else?")
  await sendIdle()
  await expect(transcript()).toContainText("Desk answer for DESK-Q3.", { timeout: 20000 })
  assert.equal(seen.chat.at(-1).context, false, "unchanged view adds no context")
  attentionDown = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.locator(".desk-source", { hasText: "Attention ledger" }).locator(".desk-source-state")).toHaveText(/^unavailable/, { timeout: 20000 })
  await editor().fill("DESK-Q4 and now?")
  await sendIdle()
  await expect(transcript()).toContainText("Desk answer for DESK-Q4.", { timeout: 20000 })
  assert.deepEqual(seen.chat.at(-1), { question: "DESK-Q4", context: true, none: true, selected: false, ledgerDown: true })
  attentionDown = false
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.locator(".desk-source", { hasText: "Attention ledger" }).locator(".desk-source-state")).toHaveText(/^current/, { timeout: 20000 })
  log("CONTEXTKEY unchanged view -> no context; ledger outage with nothing selected -> context on next send")
  if (evidence) await page.screenshot({ path: path.join(evidence, "01-expanded-chat.png") })

  // 2. Exact unsent draft and transcript survive select → close → reselect without remounting chat.
  const ids = () => page.locator(".desk-chat [data-find-message]").evaluateAll((nodes) => nodes.map((node) => node.dataset.findMessage))
  const before = await ids()
  assert(before.length >= 2, JSON.stringify(before))
  const draft = "unsent ✓ draft — keep me\nsecond line"
  await editor().fill(draft)
  await page.evaluate(() => { document.querySelector(".desk-chat .prompt-box textarea").dataset.mountProbe = "kept" })
  await page.locator(".desk-item").first().click()
  await expect(page.locator(".desk-evidence")).toContainText("Pick a rollout")
  await expect(page.locator(".desk-evidence .home-answer textarea")).toBeDisabled()
  await expect(editor()).toHaveValue(draft)
  await expect(editor()).toHaveAttribute("data-mount-probe", "kept")
  await page.getByRole("button", { name: "Close and return to chat" }).click()
  await expect(page.locator(".desk-evidence")).toHaveCount(0)
  await expect(editor()).toHaveValue(draft)
  await expect(editor()).toHaveAttribute("data-mount-probe", "kept")
  await expect(transcript()).toContainText("Desk answer for DESK-Q1.")
  assert.deepEqual(await ids(), before)
  await page.reload()
  await expect(editor()).toHaveValue(draft, { timeout: 20000 })
  await expect(transcript()).toContainText("Desk answer for DESK-Q1.", { timeout: 20000 })
  assert.deepEqual(await ids(), before)
  log(`DRAFT exact draft + message IDs ${before.join(",")} preserved across select, close and reload; chat not remounted on selection`)

  // 3. A held brief runs while another exchange completes; the second turn sees the selection.
  // A slow source-thread read plus a double click still starts exactly one check.
  await page.locator(".desk-item").first().click()
  const tailRoute = (url) => url.pathname === `/oc/session/${source.id}/message`
  let tailReads = 0
  await page.route(tailRoute, async (route) => { tailReads++; await new Promise((resolve) => setTimeout(resolve, 1500)); return route.fallback() })
  await page.evaluate(() => {
    const button = [...document.querySelectorAll(".desk-brief button")].find((item) => item.textContent === "Prepare brief")
    button.click()
    button.click()
  })
  await expect(page.locator('.desk-evidence .desk-brief[data-part="lead"]')).toContainText("Preparing brief", { timeout: 20000 })
  await poll("brief reached provider", () => hits.brief === 1)
  await page.unroute(tailRoute)
  assert.equal(tailReads, 1)
  assert.equal((await call("GET", `/session/${briefAnchor}/children`)).body.length, 1)
  log(`DOUBLECLICK deferred tail (1.5s) + two synchronous clicks -> tailReads=${tailReads} children=1 briefHits=${hits.brief}`)
  await editor().fill("DESK-Q2 summarise this one")
  await sendIdle()
  await expect(transcript()).toContainText("Desk answer for DESK-Q2.", { timeout: 20000 })
  assert.equal(holds.length, 1, "brief still held while the second exchange finished")
  assert.deepEqual(seen.chat.at(-1), { question: "DESK-Q2", context: true, none: false, selected: true, ledgerDown: false })
  log(`OVERLAP chat Q2 answered while brief held (holds=${holds.length}, briefHits=${hits.brief})`)

  // 4. Late result binds to its initiating item while nothing is selected.
  await page.getByRole("button", { name: "Close and return to chat" }).click()
  holds.shift()()
  // Brief jobs and their bindings are listed inside the folded Sources disclosure.
  await page.locator(".desk-sources-all > summary").click()
  const job = page.locator(".desk-job").first()
  await expect(job).toContainText("ready", { timeout: 20000 })
  await expect(job).toContainText("Pick a rollout")
  await expect(job).toContainText("rev 1")
  await expect(page.locator(".desk-evidence")).toHaveCount(0)
  await job.getByRole("button", { name: "Show" }).click()
  const brief = page.locator(".desk-evidence .home-decision")
  await brief.locator(".desk-brief-detail > summary").click()
  await expect(brief).toContainText("Brief for revision 1")
  await expect(page.locator(".desk-evidence .home-option-card", { hasText: "Stay at canary" })).toContainText("Traffic stays at 5% while you watch errors (rev 1)")
  await expect(brief.locator(".desk-flow li")).toHaveCount(3)
  await expect(brief).toContainText("1 uncited statement(s) omitted")
  await expect(brief).not.toContainText("Invented claim")
  await expect(brief.locator(".desk-ref", { hasText: "E2" }).first()).toBeVisible()
  await expect(page.locator(".desk-evidence .home-decision .home-options label", { hasText: "Stay at canary" })).toContainText(/recommended/i)
  const children = (await call("GET", `/session/${briefAnchor}/children`)).body
  assert.equal(children.length, 1)
  assert.equal(children[0].metadata.frontDesk.revision, "1")
  assert.equal(children[0].metadata.frontDesk.source, "attention:fixture:att_rollout")
  assert.deepEqual(children[0].permission.slice(0, 1), [{ permission: "*", pattern: "*", action: "deny" }])
  assert.deepEqual(children[0].permission.filter((rule) => rule.action === "allow").map((rule) => rule.permission).sort(), ["glob", "grep", "list", "read"])
  assert(children[0].permission.some((rule) => rule.permission === "external_directory" && rule.action === "deny"))
  assert(seen.briefTools[0].includes("read") && seen.briefTools[0].includes("grep"), JSON.stringify(seen.briefTools[0]))
  for (const name of ["bash", "edit", "write", "webfetch", "task"]) assert(!seen.briefTools[0].includes(name), `brief offered ${name}`)
  if (evidence) await page.screenshot({ path: path.join(evidence, "02-selected-brief.png") })
  log(`BINDING late brief ${children[0].id} bound to ${children[0].metadata.frontDesk.source} rev 1; briefTools=${JSON.stringify(seen.briefTools[0])}`)

  // 5. A new source revision discards the derived brief; the canonical card updates immediately.
  attentionRevision = 2
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.locator(".desk-evidence")).toContainText("revision 2", { timeout: 20000 })
  await expect(brief).toContainText("The request changed since the last brief")
  await expect(page.locator(".desk-evidence")).not.toContainText("Traffic stays at 5% while you watch errors")
  await expect(page.locator(".desk-job").first()).toContainText("revision 1 → 2")
  log("STALE revision 1 brief discarded after the source moved to revision 2")

  // The source moves on while its thread is being read: nothing starts for the outdated revision.
  const childrenBefore = (await call("GET", `/session/${briefAnchor}/children`)).body.length
  await page.route(tailRoute, async (route) => { await new Promise((resolve) => setTimeout(resolve, 3000)); return route.fallback() })
  await page.getByRole("button", { name: "Prepare brief" }).click()
  attentionRevision = 3
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.locator(".desk-evidence")).toContainText("revision 3", { timeout: 20000 })
  await expect(page.locator(".desk-background", { hasText: "source changed" })).toContainText("source changed while the brief was being prepared", { ignoreCase: true, timeout: 20000 })
  await page.unroute(tailRoute)
  assert.equal((await call("GET", `/session/${briefAnchor}/children`)).body.length, childrenBefore)
  assert.equal(hits.brief, 1)
  log("RACE revision changed during the deferred tail read -> nothing started")

  // 6. Lost create responses. Before Core: Confirm resends the identical request and creates it once.
  //    After Core: the existing child is adopted; nothing creates a second one or sends its prompt again.
  const childCreate = (request) => request.method() === "POST" && new URL(request.url()).pathname === "/oc/session" && JSON.parse(request.postData() || "{}").parentID
  await page.route(sessionRoute, (route) => childCreate(route.request()) ? route.abort("connectionreset") : route.fallback())
  await page.getByRole("button", { name: "Prepare brief" }).click()
  await expect(page.locator('.desk-evidence .desk-brief[data-part="lead"]')).toContainText("Brief start not confirmed", { timeout: 20000 })
  const lost = JSON.parse(await page.evaluate(() => localStorage.getItem("es-app:front-desk:brief-create:1")))
  assert.equal((await call("GET", `/session/${briefAnchor}/children`)).body.some((item) => item.id === lost.id), false)
  await page.reload()
  await page.locator(".desk-item").first().click()
  await expect(page.locator('.desk-evidence .desk-brief[data-part="lead"]')).toContainText("Brief start not confirmed", { timeout: 20000 })
  await expect(page.getByRole("button", { name: "Prepare brief" })).toHaveCount(0)
  await page.unroute(sessionRoute)
  let created = 0
  await page.route(sessionRoute, async (route) => {
    if (!childCreate(route.request())) return route.fallback()
    created++
    await route.fetch()
    return route.abort("connectionreset")
  })
  await page.getByRole("button", { name: "Confirm start" }).click()
  await poll("confirmed child", async () => (await call("GET", `/session/${briefAnchor}/children`)).body.some((item) => item.id === lost.id))
  await expect(page.locator('.desk-evidence .desk-brief[data-part="lead"]')).toContainText("Brief start not confirmed", { timeout: 20000 })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const adopted = (await call("GET", `/session/${briefAnchor}/children`)).body.filter((item) => item.metadata?.frontDesk?.revision === "3")
  assert.deepEqual(adopted.map((item) => item.id), [lost.id])
  assert.equal(created, 1)
  assert.equal((await messages(lost.id)).length, 0, "no prompt sent for an unconfirmed create")
  assert.equal(await page.evaluate(() => localStorage.getItem("es-app:front-desk:brief-create:1")), null)
  // The identity proof: Core reconciles an identical create to the same session.
  const again = await call("POST", "/session", lost.body)
  assert.equal(again.status, 200, again.raw)
  assert.equal(again.body.id, lost.id)
  assert.equal((await call("GET", `/session/${briefAnchor}/children`)).body.filter((item) => item.id === lost.id).length, 1)
  await page.unroute(sessionRoute)
  log(`LOSTACK create ${lost.id}: lost before Core -> confirmed once with same ID; lost after Core -> adopted, no second child, no prompt`)

  // 7. Idle polling does not reread finished briefs; an explicit refresh does, with results kept.
  holdBriefs = false
  for (const n of [1, 2, 3]) {
    const meta = { kind: "brief", requestID: `extra-${n}`, source: "attention:fixture:att_rollout", revision: "0", title: `Extra ${n}`, refs: [{ id: "C1", label: "canonical" }, { id: "E2", label: "evidence" }] }
    const extra = (await call("POST", "/session", { parentID: briefAnchor, title: `Brief: Extra ${n}`, metadata: { frontDesk: meta }, permission: [{ permission: "*", pattern: "*", action: "deny" }] })).body
    await call("POST", `/session/${extra.id}/prompt_async`, { parts: [{ type: "text", text: "Prepare an evidence brief\nsource revision: 0" }] })
    await poll(`extra ${n} settled`, async () => (await status(extra.id)) === "idle" && (await messages(extra.id)).at(-1)?.info.time?.completed)
  }
  holdBriefs = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  const childIDs = new Set((await call("GET", `/session/${briefAnchor}/children`)).body.map((item) => item.id))
  assert.equal(childIDs.size, 5)
  await expect(page.locator(".desk-job")).toHaveCount(5, { timeout: 20000 })
  await expect(page.locator(".desk-job", { hasText: "Extra 3" })).toContainText("not current")
  const briefReads = []
  page.on("request", (request) => {
    const match = /^\/oc\/session\/([^/]+)\/message$/.exec(new URL(request.url()).pathname)
    if (request.method() === "GET" && match && childIDs.has(match[1])) briefReads.push(match[1])
  })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  briefReads.splice(0)
  const childLists = posts.length
  await new Promise((resolve) => setTimeout(resolve, 33_000)) // two idle ticks
  assert.deepEqual(briefReads, [], "idle ticks reread no finished brief")
  await expect(page.locator(".desk-job")).toHaveCount(5)
  await page.getByRole("button", { name: "Close and return to chat" }).click()
  await page.locator(".desk-job", { hasText: "Extra" }).first().waitFor({ state: "attached" })
  await page.locator(".desk-item").first().click()
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await poll("explicit refresh reread", () => new Set(briefReads).size === childIDs.size)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.equal(briefReads.length, childIDs.size, "explicit refresh reads each brief once")
  await expect(page.locator(".desk-job")).toHaveCount(5)
  log(`FANOUT children=${childIDs.size}: idle 33s -> 0 transcript reads; explicit refresh -> ${briefReads.length} (one each); all 5 jobs listed; postsDuringIdle=${posts.length - childLists}`)

  // 8. Memory: one personal file behind the real dashboard seam (private HOME). The desk's own
  //    fenced change applies once with its source; the human edits, restores, forgets and erases;
  //    a concurrent writer is never overwritten; credentials are refused.
  operatorReal = true
  await page.getByRole("button", { name: "Close and return to chat" }).click()
  await page.reload()
  await expect(editor()).toBeVisible({ timeout: 20000 })
  const memoryFile = path.join(home, ".local/share/opencode/front-desk/memory.json")
  const memoryDoc = async () => JSON.parse(await readFile(memoryFile, "utf8"))
  await editor().fill("DESK-M1 remember I work in UTC")
  await sendIdle()
  await expect(transcript()).toContainText("Noted.", { timeout: 20000 })
  await poll("assistant memory revision", async () => (await memoryDoc().catch(() => ({ revision: 0 }))).revision === 1)
  const m1 = (await messages(pointer.session)).findLast((item) => item.info.role === "assistant").info.id
  let file = await memoryDoc()
  assert.deepEqual(file.history.map((item) => [item.n, item.change.actor, item.change.messageID, item.change.opKey]), [[1, "assistant", m1, `${m1}:0`]])
  assert.deepEqual(file.entries.map((item) => [item.id, item.text, item.confidence, item.source.messageID]), [["tz", "Works in UTC", "tentative", m1]])
  assert.equal(JSON.stringify(file).includes("sk-test"), false, "credential never stored")
  assert.equal((await stat(memoryFile)).mode & 0o777, 0o600)
  await page.getByRole("button", { name: /^Memory/ }).click()
  await expect(page.locator(".desk-memory")).toContainText("Works in UTC")
  await expect(page.locator(".desk-memory")).toContainText("looks like a credential")
  await page.reload()
  await page.getByRole("button", { name: /^Memory/ }).click()
  await expect(page.locator(".desk-memory")).toContainText("Works in UTC", { timeout: 20000 })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  assert.equal((await memoryDoc()).revision, 1, "reload does not reapply the same change")
  await editor().fill("DESK-M2 what do you remember?")
  await sendIdle()
  await expect(transcript()).toContainText("Desk answer for DESK-M2.", { timeout: 20000 })
  assert.deepEqual(seen.memory["DESK-M2"], ["1", "tz"])
  const row = page.locator('.desk-memory [data-memory-id="tz"]')
  await row.getByRole("button", { name: "Edit" }).click()
  await row.getByRole("textbox").fill("Works in UTC, reviews in the morning")
  await row.getByRole("button", { name: "Save" }).click()
  await expect(row).toContainText("from you", { timeout: 20000 })
  await page.locator(".desk-memory-history summary").click()
  await page.locator('.desk-memory [data-memory-revision="1"]').getByRole("button", { name: "Restore" }).click()
  await expect(row).toContainText("Works in UTC", { timeout: 20000 })
  await expect(row).not.toContainText("morning")
  await row.getByRole("button", { name: "Forget" }).click()
  await expect(page.locator('.desk-memory [data-memory-id="tz"]')).toHaveCount(0, { timeout: 20000 })
  file = await memoryDoc()
  assert.deepEqual(file.history.map((item) => [item.n, item.change.actor, item.change.op, item.entries.length]), [[1, "assistant", "upsert", 1], [2, "human", "upsert", 1], [3, "human", "restore", 1], [4, "human", "forget", 0]])
  assert.equal("messageID" in file.history[1].change, false, "human edits carry no desk message")
  await page.getByRole("button", { name: "Erase from history" }).click()
  await expect(page.locator(".desk-memory")).toContainText('Erased "tz" from history', { timeout: 20000 })
  file = await memoryDoc()
  assert.equal(file.revision, 5)
  assert.equal(JSON.stringify(file).includes("Works in UTC"), false)
  assert.deepEqual(file.applied, [`${m1}:0`], "the applied desk change stays consumed")
  await new Promise((resolve) => setTimeout(resolve, 2000))
  assert.equal((await memoryDoc()).revision, 5, "erasing history does not bring the note back")
  // Another writer (a second tab) saves first; this page's stale write is refused, not merged.
  const fixtureCall = (method, body) => fetch(`${memoryBase}/api/frontdesk/memory`, { method, headers: { "content-type": "application/json", "X-Attention-CSRF": "1", authorization: `Bearer ${operatorToken}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const fresh = await (await fixtureCall("GET")).json()
  const otherEntry = { id: "other", text: "Written in another tab", kind: "fact", scope: "global", confidence: "stated", source: { actor: "human" }, created: 1, updated: 1 }
  const other = { ...fresh.document, revision: 6, entries: [otherEntry], history: [...fresh.document.history, { n: 6, at: 1, change: { op: "upsert", entryID: "other", actor: "human" }, entries: [otherEntry] }] }
  assert.equal((await fixtureCall("PUT", { expected_hash: fresh.hash, document: other })).status, 200)
  const clash = await fixtureCall("PUT", { expected_hash: fresh.hash, document: { ...other, entries: [], history: [...fresh.document.history, { n: 6, at: 1, change: { op: "upsert", actor: "human" }, entries: [] }] } })
  assert.equal(clash.status, 409)
  await page.getByLabel("Note ID").fill("morning")
  await page.getByLabel("Note text").fill("Reviews in the morning")
  await page.getByRole("button", { name: "Add note" }).click()
  await expect(page.locator(".desk-memory")).toContainText("Memory changed elsewhere first", { timeout: 20000 })
  await expect(page.locator(".desk-memory")).toContainText("Written in another tab")
  assert.deepEqual((await memoryDoc()).entries.map((item) => item.id), ["other"])
  await page.getByRole("button", { name: "Add note" }).click()
  await expect(page.locator('.desk-memory [data-memory-id="morning"]')).toHaveCount(1, { timeout: 20000 })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  file = await memoryDoc()
  assert.equal(file.revision, 7)
  assert.deepEqual(file.entries.map((item) => item.id), ["other", "morning"])
  if (evidence) await page.screenshot({ path: path.join(evidence, "04-memory.png") })
  log(`MEMORY file=${memoryFile} mode=600; desk r1 from ${m1} (secret refused); reload no reapply; context rev1; edit/restore/forget r2-r4; erase r5 scrubs history, note not reapplied; concurrent writer -> 409 for stale tab, retry r7`)

  // 9. Interrupted pass: Core restarts mid-brief; the desk reports unknown and does not rerun it.
  const briefBase = hits.brief
  const metadataBefore = (await call("GET", `/session/${briefAnchor}/children`)).body.map((item) => [item.id, item.metadata])
  await page.locator(".desk-item").first().click()
  await page.getByRole("button", { name: "Prepare again" }).click()
  await poll("second brief reached provider", () => hits.brief === briefBase + 1)
  await stopCore()
  holds.splice(0)
  await startCore("restarted")
  await page.reload()
  await page.locator(".desk-item").first().click()
  await expect(page.locator('.desk-evidence .desk-brief[data-part="lead"]')).toContainText("stopped before finishing", { timeout: 20000 })
  const metadataAfter = new Map((await call("GET", `/session/${briefAnchor}/children`)).body.map((item) => [item.id, item.metadata]))
  for (const [id, metadata] of metadataBefore) assert.deepEqual(metadataAfter.get(id), metadata, `metadata of ${id} survives restart`)
  await new Promise((resolve) => setTimeout(resolve, 4000))
  assert.equal(hits.brief, briefBase + 1, "no automatic rerun after restart")
  await expect(editor()).toHaveValue("")
  await expect(transcript()).toContainText("Desk answer for DESK-Q2.")
  log(`RESTART interrupted brief shown as unknown; briefHits=${hits.brief} (no rerun)`)

  // 10. A new desk conversation starts with the same memory in its first context.
  await page.evaluate(() => localStorage.removeItem("es-app:front-desk:1"))
  await page.reload()
  await page.getByRole("button", { name: "Start chat" }).click()
  await expect(editor()).toBeVisible({ timeout: 20000 })
  pointerID = JSON.parse(await page.evaluate(() => localStorage.getItem("es-app:front-desk:1"))).session
  assert.notEqual(pointerID, pointer.session)
  await editor().fill("DESK-M3 hello again")
  await sendIdle()
  await expect(transcript()).toContainText("Desk answer for DESK-M3.", { timeout: 20000 })
  assert.deepEqual(seen.memory["DESK-M3"], ["7", "morning"])
  log(`MEMORY new desk session ${pointerID} received memory r7 in its first context`)

  // 11. Automatic preparation: with the setting on, a new or changed decision is prepared without
  //     any click. The job retrieves local context read-only, returns a sandboxed bespoke visual, and
  //     the desk shows it leading the card with the original request behind a disclosure. One job per
  //     revision: reload and the desk reuse it; a new revision gets a new job; nothing prompts.
  await writeFile(path.join(project, "ROLLOUT.md"), "The canary owner is Kim.\n")
  holdBriefs = false
  attentionRevision = 6
  await page.goto(`${origin}/`)
  await page.getByLabel("Auto briefs").check()
  const autoHits = hits.brief
  // A second client (another window or device) runs its own provider at the same moment.
  const second = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await second.addInitScript(() => { localStorage.setItem("es-app:front-desk:auto-prepare", "on") })
  const secondPage = await second.newPage()
  // The Front Desk at "/" opens the decision by key; the brief leads its card.
  const rollout = `${origin}/?item=${encodeURIComponent("attention:fixture:att_rollout")}`
  await Promise.all([page.goto(rollout), secondPage.goto(rollout)])
  const card = page.locator('.home-decision[data-attention-id="att_rollout"]')
  await expect(card).toContainText("revision 6", { timeout: 40000 })
  await expect(card.getByRole("button", { name: "Prepare brief" })).toHaveCount(0)
  await expect(card.locator("h3.home-question")).toContainText("Choose whether to stay at the canary or roll out fully", { timeout: 60000 })
  await expect(card).toContainText("Kim owns the canary")
  await card.locator(".desk-brief-detail > summary").click()
  await expect(card.locator(".desk-brief .desk-ref", { hasText: "file:ROLLOUT.md" })).toBeVisible()
  assert.deepEqual(seen.retrieved, [true], "the job read the project file through the read tool")
  const frame = card.locator(".desk-visual iframe")
  await expect(frame).toHaveAttribute("sandbox", "")
  assert((await frame.getAttribute("srcdoc")).includes("default-src 'none'"))
  await expect(frame.contentFrame().locator("#cmp")).toContainText("Full rollout")
  assert.equal(await frame.contentFrame().locator("body").getAttribute("data-ran"), null, "visual scripts never run")
  const original = card.locator(".home-original")
  await expect(original.locator("p")).toBeHidden()
  await original.locator("summary").click()
  await expect(original).toContainText("The canary is healthy. Choose how far to roll out.")
  await expect(card.locator(".home-options label", { hasText: "Stay at canary" })).toContainText(/recommended/i)
  await expect(card.getByRole("radio")).toHaveCount(2)
  await expect(secondPage.locator('.home-decision[data-attention-id="att_rollout"] h3.home-question')).toContainText("Choose whether", { timeout: 60000 })
    .catch(async (error) => { console.error(`--- second client: ${(await secondPage.locator("main").innerText().catch(() => "none")).slice(0, 1500)}`); throw error })
  assert.equal(hits.brief, autoHits + 2, "one automatic job across two clients: one tool step and one reply")
  const rev6 = (await call("GET", `/session/${briefAnchor}/children`)).body.filter((item) => item.metadata?.frontDesk?.revision === "6")
  assert.equal(rev6.length, 1)
  assert.match(rev6[0].id, /^ses_fdjob_[0-9a-f]{24}$/)
  await second.close()
  assert.deepEqual((await call("GET", "/permission")).body, [], "no permission request was created")
  if (evidence) await page.screenshot({ path: path.join(evidence, "05-home-auto-brief.png"), fullPage: true })
  await page.reload()
  await expect(card.locator("h3.home-question")).toContainText("Choose whether", { timeout: 20000 })
  await page.goto(`${origin}/`)
  await page.locator(".desk-item").first().click()
  await expect(page.locator(".desk-evidence h3.home-question")).toContainText("Choose whether to stay at the canary", { timeout: 20000 })
  await new Promise((resolve) => setTimeout(resolve, 3000))
  assert.equal(hits.brief, autoHits + 2, "reload and the desk reuse the job")
  assert.equal((await call("GET", `/session/${briefAnchor}/children`)).body.filter((item) => item.metadata?.frontDesk?.revision === "6").length, 1)
  attentionRevision = 7
  await page.goto(rollout)
  await expect(card).toContainText("revision 7", { timeout: 40000 })
  await expect(card.locator("h3.home-question")).toContainText("Choose whether", { timeout: 60000 })
  await expect(card).toContainText("Brief for revision 7")
  assert.equal((await call("GET", `/session/${briefAnchor}/children`)).body.filter((item) => item.metadata?.frontDesk?.revision === "7").length, 1)
  assert.equal(hits.brief, autoHits + 4)
  // Backlog: six more open decisions arrive at once. The newest start first, never more than two at a time.
  holdBriefs = true
  for (const n of [1, 2, 3, 4, 5, 6]) extraRecords.push(extraRecord(n))
  await page.goto(`${origin}/`)
  const extraJobs = async () => (await call("GET", `/session/${briefAnchor}/children`)).body.filter((item) => item.metadata?.frontDesk?.source?.startsWith("attention:fixture:att_extra_"))
  await poll("first backlog jobs", async () => (await extraJobs()).length === 2)
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const firstTwo = (await extraJobs()).map((item) => item.metadata.frontDesk.source).sort()
  assert.deepEqual(firstTwo, ["attention:fixture:att_extra_5", "attention:fixture:att_extra_6"], "newest first, two at a time")
  let peak = 0
  for (let released = 0; released < 6; released++) {
    await poll("a held backlog brief", () => holds.length > 0, 60000)
    const statuses = (await call("GET", "/session/status")).body
    peak = Math.max(peak, (await extraJobs()).filter((item) => ["busy", "retry"].includes(statuses[item.id]?.type)).length)
    holds.shift()()
  }
  await poll("backlog done", async () => (await extraJobs()).length === 6)
  const order = (await extraJobs()).sort((a, b) => a.time.created - b.time.created).map((item) => item.metadata.frontDesk.source.slice(-1))
  assert.deepEqual(order, ["6", "5", "4", "3", "2", "1"])
  assert(peak <= 2, `peak running ${peak}`)
  holdBriefs = false
  holds.splice(0).forEach((release) => release())
  log(`BACKLOG 6 new decisions -> first two jobs = newest (extra_5, extra_6); peak running ${peak}; created newest-first ${order.join(",")}`)
  log(`AUTOBRIEF no click: rev 6 prepared with read tool (file:ROLLOUT.md cited), sandboxed visual (scripts/network blocked), original behind disclosure; reload+desk reuse one job; rev 7 -> one new job; permissions=[]`)

  // 11b. More detail: an explicit question about the selected decision reaches the desk conversation with
  //      bounded evidence and citable links, gets an answer there, and leaves the chat draft alone.
  await page.goto(rollout)
  await expect(card.locator("h3.home-question")).toBeVisible({ timeout: 30000 })
  await editor().fill("my unsent draft")
  const briefsBeforeDetail = hits.brief
  await card.getByRole("button", { name: "More detail" }).click()
  await card.getByRole("textbox", { name: "Question for the front desk (optional)" }).fill("DESK-Q9 why the canary first?")
  await card.getByRole("button", { name: "Ask" }).click()
  await expect(card.locator(".desk-more")).toContainText("Asked in the chat.", { timeout: 20000 })
  await expect(transcript()).toContainText("More detail: Pick a rollout", { timeout: 20000 })
  await expect(transcript()).toContainText("Desk answer for DESK-Q9.", { timeout: 20000 })
  await expect(editor()).toHaveValue("my unsent draft")
  const deskMessages = await messages(pointerID)
  const asked = deskMessages.findLast((message) => message.info.role === "user")
  const detailPart = asked.parts.find((part) => part.metadata?.source === "es-app/front-desk-detail")
  assert(detailPart?.synthetic && detailPart.text.includes("attention:fixture:att_rollout at revision 7") && detailPart.text.includes("&message="), "detail evidence bound to the revision with message links")
  assert.equal(hits.brief, briefsBeforeDetail, "asking starts no brief job")
  await new Promise((resolve) => setTimeout(resolve, 2000))
  assert.equal((await messages(pointerID)).filter((message) => message.info.role === "user" && message.parts.some((part) => part.metadata?.source === "es-app/front-desk-detail")).length, 1, "one send per click")
  await editor().fill("")
  log(`DETAIL More detail on rev 7 -> one desk message with bound evidence + links, answered in chat; draft kept; briefs unchanged`)

  // 11c. Model: every desk turn and brief ran on the desk model. A conversation that had inherited
  //      another model switches through its model preference at its next turn, keeping its history.
  assert(seen.models.chat.length && seen.models.chat.every(([, model]) => model === "gpt-6.1-sol"), JSON.stringify(seen.models.chat))
  assert(seen.models.brief.length && seen.models.brief.every((model) => model === "gpt-6.1-sol"), JSON.stringify(seen.models.brief))
  const inherited = (await call("POST", "/session", { title: "Front desk", agent: "front-desk", permission: [{ permission: "edit", pattern: "*", action: "deny" }] })).body
  const oldTurn = await call("POST", `/session/${inherited.id}/message`, { agent: "front-desk", parts: [{ type: "text", text: "DESK-Q7 earlier question" }] })
  assert.equal(oldTurn.status, 200, oldTurn.raw)
  // Fixture: the old conversation ran on the agent's default.
  assert.deepEqual(seen.models.chat.at(-1), ["DESK-Q7", "claude-fable-5"])
  await page.evaluate(([session, directory]) => localStorage.setItem("es-app:front-desk:1", JSON.stringify({ session, directory })), [inherited.id, inherited.directory])
  pointerID = inherited.id
  await page.goto(`${origin}/`)
  await poll("model preference", async () => (await call("GET", `/session/${inherited.id}`)).body.preferredModel?.id === "gpt-6.1-sol")
  await expect(transcript()).toContainText("Desk answer for DESK-Q7.", { timeout: 20000 })
  await editor().fill("DESK-Q8 after the switch")
  await sendIdle()
  await expect(transcript()).toContainText("Desk answer for DESK-Q8.", { timeout: 20000 })
  assert.deepEqual(seen.models.chat.at(-1), ["DESK-Q8", "gpt-6.1-sol"])
  assert.equal((await messages(inherited.id)).filter((message) => message.info.role === "user").length, 2, "history kept")
  log(`MODEL desk turns ${seen.models.chat.length} + briefs ${seen.models.brief.length} on gpt-6.1-sol; inherited Fable conversation switched at its next turn (preference set, history kept)`)

  // 12. Authority: nothing answered, granted or retried on anyone's behalf.
  assert.deepEqual(attentionPosts, [])
  assert.equal(posts.filter((item) => item.endsWith("/input")).length, 0, "every desk send was a plain send")
  assert.equal(posts.filter((item) => /\/(permission|question)\/.*\/reply|\/retry$/.test(item)).length, 0)
  log(`AUTHORITY attentionWrites=0 permissionReplies=0 retries=0 posts=${[...new Set(posts)].join(",")}`)

  // 13. Narrow width keeps both views reachable.
  await page.goto(`${origin}/`)
  await page.locator(".desk-item").first().click()
  await page.setViewportSize({ width: 760, height: 900 })
  await expect(page.locator(".desk-evidence")).toBeVisible()
  await expect(editor()).toBeVisible()
  if (evidence) await page.screenshot({ path: path.join(evidence, "03-narrow.png"), fullPage: true })
  log(`PROVIDER hits=${JSON.stringify(hits)}`)

  if (serve) {
    // Reviewers get immediate briefs; a held one is only for the overlap proof.
    holdBriefs = false
    log(`PREVIEW ${origin}/\nCORE ${base} PID=${child.pid} DB=${db}\nSTOP kill ${process.pid}`)
    await browser.close()
    browser = undefined
    await new Promise((resolve) => { process.on("SIGTERM", resolve); process.on("SIGINT", resolve) })
  }
  log("FRONT DESK REAL: PASS")
} catch (error) {
  if (page && evidence) await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => {})
  if (page) console.error(`--- desk background: ${await page.locator(".desk-background").allInnerTexts().then(texts => texts.join(" | ")).catch(() => "none")}`)
  console.error(`FAIL ${error?.message ?? ""}\n${error?.stack ?? error}\n--- core stdout tail\n${output.slice(-2000)}\n--- core stderr tail\n${diagnostics.slice(-3000)}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
  await stopCore().catch(() => {})
  if (memoryFixture) try { process.kill(-memoryFixture.pid, "SIGTERM") } catch {}
  provider.closeAllConnections?.()
  await new Promise((resolve) => provider.close(resolve))
  dashboard.closeAllConnections?.()
  await new Promise((resolve) => dashboard.close(resolve))
  if (!serve || process.exitCode) await rm(home, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}

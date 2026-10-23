// Briefs prepare with no client open: producer CLI publish -> dashboard prep loop (real ledger) ->
// private compiled Core child job -> fake provider brief -> the desk opened later shows it ready and
// starts no second job. Private runtime/DB/editspace/key and fake provider only.
//
// Run from packages/es-app:
//   ATTENTION_E2E_BINARY=/abs/opencode ES_ATTENTION_FIXTURE=/abs/dotfiles/tests/attention_fixture.py \
//   node test/front-desk-server-prep.real.mjs
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import http from "node:http"
import net from "node:net"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { apiProxy } from "../api-proxy.ts"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const binary = process.env.ATTENTION_E2E_BINARY
const fixtureScript = process.env.ES_ATTENTION_FIXTURE
assert(binary && path.isAbsolute(binary), "ATTENTION_E2E_BINARY must be an absolute executable")
assert(fixtureScript && path.isAbsolute(fixtureScript), "ES_ATTENTION_FIXTURE must be absolute")
await access(binary, constants.X_OK)
const es = path.join(path.dirname(path.dirname(fixtureScript)), "bin", "es")
const home = await mkdtemp(path.join(tmpdir(), "front-desk-server-prep-"))
const spaces = path.join(home, "spaces")
const root = path.join(spaces, "fleet")
const lane = path.join(root, "lanes", "work")
await mkdir(lane, { recursive: true })
await writeFile(path.join(root, "EDITSPACE.md"), "# fleet\n")
const log = []
const record = (line) => { log.push(line); console.log(line) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const poll = async (name, fn, ms = 60_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(200)
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

// Fake provider: a brief job (its system prompt asks for a decision brief) gets a brief; anything else an ack.
const ASK = "Choose whether to stay at the canary or roll out fully."
const briefCalls = []
const provider = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString()
  const brief = body.includes("You help a busy person decide one request")
  if (brief) briefCalls.push(body)
  const content = brief
    ? JSON.stringify({ question: ASK, choices: [{ id: "canary", outcome: "The canary keeps 5% of traffic" },
      { id: "full", outcome: "Every user gets the release now" }], sources: [], gaps: [],
      facts: [{ text: "The canary is healthy.", refs: ["C1"] }], timeline: [] })
    : "synthetic ack"
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
  response.end("data: [DONE]\n\n")
})
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))

const children = []
let preview
let browser
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { children.forEach((child) => { try { process.kill(-child.pid, "SIGKILL") } catch {} }); process.exit(130) })
try {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const config = { formatter: false, lsp: false, server: { hostname: "127.0.0.1", port, mdns: false }, provider: { test: { name: "Test", id: "test", env: [], npm: "@ai-sdk/openai-compatible",
    models: { "test-model": { id: "test-model", name: "Test Model", attachment: false, reasoning: false, temperature: false, tool_call: true, release_date: "2025-01-01", limit: { context: 100_000, output: 10_000 }, cost: { input: 0, output: 0 }, options: {} } },
    options: { apiKey: "test-key", baseURL: `http://127.0.0.1:${provider.address().port}/v1` } } } }
  const runtime = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: home, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`,
    XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`, OPENCODE_DB: path.join(home, "opencode.sqlite"), OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: `${home}/config/opencode`, OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`, OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true", OPENCODE_SERVER_PASSWORD: "", OPENCODE_PERMISSION: "{}",
  } })
  children.push(runtime)
  let runtimeOut = ""
  runtime.stdout.on("data", (chunk) => { runtimeOut += chunk })
  runtime.stderr.on("data", (chunk) => { runtimeOut += chunk })
  assert.equal(await poll("runtime listening", () => runtimeOut.match(/listening on (http:\/\/[^\s]+)/)?.[1]), base)
  record(`ISOLATION runtime binary=${binary} pid=${runtime.pid} url=${base}`)
  const api = async (method, route, body, directory) => {
    const response = await fetch(`${base}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, {
      method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const producer = (await api("POST", "/session", { title: "work: producer", agent: "build", model: { id: "test-model", providerID: "test" } }, lane)).body.id
  await writeFile(path.join(lane, "LANE.md"), `# Lane: work\nowner: ${producer}\n`)

  const uiPort = await freePort()
  const uiOrigin = `http://127.0.0.1:${uiPort}`
  const fixture = spawn("uv", ["run", "--script", fixtureScript, "--origin", uiOrigin, "--root", spaces, "--frontdesk-prep", "fleet", "--interval", "0.5"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENCODE_URL: base, ES_OPENCODE_TIMEOUT: "10" } })
  children.push(fixture)
  let fixtureOut = ""
  fixture.stdout.on("data", (chunk) => { fixtureOut += chunk })
  fixture.stderr.on("data", (chunk) => { fixtureOut += chunk })
  const dashboard = JSON.parse(await poll("dashboard fixture", () => fixtureOut.split("\n").find((line) => line.startsWith('{"url":')), 120_000))
  const anchorRoot = (await (await fetch(`${dashboard.url}/fixture`)).json()).projects.find((item) => item.name === "fleet").root
  record(`ISOLATION dashboard pid=${dashboard.pid} url=${dashboard.url} prep anchored at ${anchorRoot}`)

  // 1. Publish with no client open anywhere: the dashboard starts the brief job by itself.
  const cliEnv = { ...process.env, EDITSPACES_ROOT: spaces, ES_ATTENTION_AUTH_FILE: path.join(spaces, "private", "attention.key"),
    ES_DASHBOARD_URL: dashboard.url, OPENCODE_URL: base, EDITSPACE_AGENT_ID: `opencode:${producer}` }
  const published = JSON.parse(execFileSync("python3", [es, "attention", "publish", "--editspace", "fleet"], { cwd: lane, env: cliEnv, encoding: "utf8", timeout: 60_000,
    input: JSON.stringify({ command_id: "publish:rollout", gate_key: "rollout:v1", kind: "decision", title: "Pick a rollout",
      context: "The canary is healthy. Choose how far to roll out.", options: [{ id: "canary", label: "Stay at canary" }, { id: "full", label: "Full rollout" }],
      recommendation: "canary" }) })).record
  const source = `attention:fleet:${published.id}`
  // The documented public anchor shape: ses_fdbrief_<sha256(editspace root)[:20]>.
  const anchorID = `ses_fdbrief_${createHash("sha256").update(anchorRoot).digest("hex").slice(0, 20)}`
  const jobsFor = async (id) => (await api("GET", `/session/${id}/children`, undefined, anchorRoot)).body.filter((item) => item.metadata?.frontDesk?.source === source)
  const job = await poll("server-started job", async () => {
    const found = await api("GET", `/session/${anchorID}/children`, undefined, anchorRoot)
    return found.status === 200 && found.body.find((item) => item.metadata?.frontDesk?.source === source)
  })
  assert.match(job.id, /^ses_fdjob_[0-9a-f]{24}$/)
  assert.equal(job.metadata.frontDesk.revision, "1")
  await poll("brief reply", async () => (await api("GET", `/session/${job.id}/message`, undefined, anchorRoot)).body.some((message) => message.info.role === "assistant" && message.info.time.completed))
  assert.equal(briefCalls.length, 1)
  assert(briefCalls[0].includes("Pick a rollout") && briefCalls[0].includes("recommended option: canary"))
  record(`SERVER no client open: dashboard started ${job.id} under ${anchorID} for ${source} rev 1; provider brief calls=${briefCalls.length}`)

  // 2. The desk opened later shows that brief ready and adopts it: no second job, no second provider call.
  preview = await startPanelPreview([{ name: "private-real-attention-proxy", configResolved(viteConfig) {
    viteConfig.server.proxy = { "/es/api/attention": apiProxy(dashboard.url, "/es"), ...viteConfig.server.proxy }
  } }], uiPort, { opencode: base })
  // The client anchors briefs at its default editspace's root, the same root the dashboard uses.
  preview.fixture.editspaces = [{ name: "fixture", root: anchorRoot }]
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => { localStorage.setItem("es-app-all-projects", "true"); localStorage.setItem("es-app:front-desk:auto-prepare", "on") })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === uiOrigin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(`${uiOrigin}/?item=${encodeURIComponent(source)}`)
  const card = page.locator(`[data-attention-id="${published.id}"]`)
  await expect(card.locator("h3.home-question")).toContainText(ASK, { timeout: 60_000 })
  await expect(card.locator(".home-option-card", { hasText: "Full rollout" })).toContainText("Every user gets the release now")
  await expect(card.locator(".home-original summary")).toHaveText("Original request")
  await sleep(5000)
  assert.equal((await jobsFor(anchorID)).length, 1, "the client adopted the server's job")
  assert.equal(briefCalls.length, 1, "no second brief was generated")
  record(`CLIENT desk opened later shows the server-prepared brief; jobs=1 briefCalls=${briefCalls.length}`)
  record("PASS server-side Front Desk prep: brief prepared with no client open, shown ready and adopted by the desk")
} catch (error) {
  record(`FAIL ${error.stack ?? error}`)
  process.exitCode = 1
} finally {
  await browser?.close()
  await preview?.close()
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM") } catch {}
    await Promise.race([new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve)), sleep(5000)])
    try { process.kill(-child.pid, "SIGKILL") } catch {}
  }
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  const result = path.join(process.env.ATTENTION_E2E_RESULT_DIR ?? tmpdir(), `front-desk-server-prep-${process.pid}.log`)
  await writeFile(result, log.join("\n") + "\n")
  if (!process.env.ATTENTION_E2E_KEEP) await rm(home, { recursive: true, force: true })
  console.log(`RESULT ${result}`)
}

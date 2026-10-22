// End-to-end written answer: producer CLI publish -> browser typed answer -> dashboard outbox ->
// lane mail -> private OpenCode runtime admission -> fake provider sees the answer -> agent acks/resolves.
// Covers idle, busy (steer) and verified-successor delivery. Private runtime/DB/editspace/key only.
//
// Run from packages/es-app:
//   ATTENTION_E2E_BINARY=/abs/opencode ES_ATTENTION_FIXTURE=/abs/dotfiles/tests/attention_fixture.py \
//   node test/attention-answer.real.mjs
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import http from "node:http"
import net from "node:net"
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
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
const sha256 = createHash("sha256").update(await readFile(binary)).digest("hex")
const FLEET = "i like the direction of A and C"
const BUSY = "Busy-case answer: keep going, then switch to C"
const SUCCESSOR = "Successor-case answer: A only"
const home = await mkdtemp(path.join(tmpdir(), "attention-answer-real-"))
const spaces = path.join(home, "spaces")
const root = path.join(spaces, "fleet")
const lane = path.join(root, "lanes", "work")
await mkdir(lane, { recursive: true })
await writeFile(path.join(root, "EDITSPACE.md"), "# fleet\n")
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

// Gated fake provider: `hold` keeps the next turn busy until released.
const providerCalls = []
const held = []
let hold = false
const provider = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  providerCalls.push(Buffer.concat(chunks).toString())
  response.writeHead(200, { "content-type": "text/event-stream" })
  const finish = () => {
    if (response.writableEnded) return
    response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "synthetic ack" }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  }
  if (hold) { hold = false; held.push(finish) } else finish()
})
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))

const children = []
let preview
let browser
// An external timeout must not orphan the private runtime or dashboard.
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { children.forEach((child) => { try { process.kill(-child.pid, "SIGKILL") } catch {} }); process.exit(130) })
try {
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const config = { formatter: false, lsp: false, server: { hostname: "127.0.0.1", port, mdns: false }, provider: { test: { name: "Test", id: "test", env: [], npm: "@ai-sdk/openai-compatible",
    models: { "test-model": { id: "test-model", name: "Test Model", attachment: false, reasoning: false, temperature: false, tool_call: true, release_date: "2025-01-01", limit: { context: 100_000, output: 10_000 }, cost: { input: 0, output: 0 }, options: {} } },
    options: { apiKey: "test-key", baseURL: `http://127.0.0.1:${provider.address().port}/v1` } } } }
  const runtime = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: home, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`,
    XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`, OPENCODE_DB: db, OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: `${home}/config/opencode`, OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`, OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true", OPENCODE_SERVER_PASSWORD: "", OPENCODE_PERMISSION: "{}",
  } })
  children.push(runtime)
  let runtimeOut = ""
  runtime.stdout.on("data", (chunk) => { runtimeOut += chunk })
  runtime.stderr.on("data", (chunk) => { runtimeOut += chunk })
  const listening = await poll("runtime listening", () => runtimeOut.match(/listening on (http:\/\/[^\s]+)/)?.[1])
  assert.equal(listening, base)
  const owner = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")
  assert(owner.includes(String(runtime.pid)), `listener ${owner} is not runtime ${runtime.pid}`)
  assert((await stat(db)).isFile())
  record(`ISOLATION runtime binary=${binary} sha256=${sha256} pid=${runtime.pid} url=${base} db=${db}`)
  const api = async (method, route, body, directory = lane) => {
    const response = await fetch(`${base}${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, {
      method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const sessionA = (await api("POST", "/session", { title: "work: producer A", agent: "build", model: { id: "test-model", providerID: "test" } })).body.id
  await writeFile(path.join(lane, "LANE.md"), `# Lane: work\nowner: ${sessionA}\n`)

  const uiPort = await freePort()
  const uiOrigin = `http://127.0.0.1:${uiPort}`
  const fixture = spawn("uv", ["run", "--script", fixtureScript, "--origin", uiOrigin, "--root", spaces, "--deliver", "--interval", "0.5"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENCODE_URL: base, ES_OPENCODE_TIMEOUT: "10" } })
  children.push(fixture)
  let fixtureOut = ""
  fixture.stdout.on("data", (chunk) => { fixtureOut += chunk })
  fixture.stderr.on("data", (chunk) => { fixtureOut += chunk })
  const dashboard = JSON.parse(await poll("dashboard fixture", () => fixtureOut.split("\n").find((line) => line.startsWith('{"url":')), 120_000))
  assert.equal(dashboard.root, spaces)
  record(`ISOLATION dashboard pid=${dashboard.pid} url=${dashboard.url} editspaces=${spaces} deliver=on`)
  const cliEnv = (session) => ({ ...process.env, EDITSPACES_ROOT: spaces, ES_ATTENTION_AUTH_FILE: path.join(spaces, "private", "attention.key"),
    ES_DASHBOARD_URL: dashboard.url, OPENCODE_URL: base, ES_DEFAULT_MODEL: "test/test-model", ...(session ? { EDITSPACE_AGENT_ID: `opencode:${session}` } : { EDITSPACE_AGENT_ID: "" }) })
  const run = (session, args, input) => execFileSync("python3", [es, ...args], { cwd: lane, env: cliEnv(session), input, encoding: "utf8", timeout: 60_000 })
  const publish = (session, gate, title) => JSON.parse(run(session, ["attention", "publish", "--editspace", "fleet"], JSON.stringify({
    command_id: `publish:${gate}`, gate_key: gate, kind: "decision", title, context: "Synthetic private e2e request.",
    options: [{ id: "project-map", label: "A — Project map" }, { id: "fleet-orbit", label: "B — Fleet orbit" }, { id: "time-weave", label: "C — Time weave" }],
    recommendation: "project-map" }))).record
  const ledger = async (id) => (await (await fetch(`${dashboard.url}/api/attention/${id}?es=fleet`)).json()).record
  const sawInProvider = (text) => providerCalls.some((body) => body.includes(JSON.stringify(text).slice(1, -1)))

  preview = await startPanelPreview([{ name: "private-real-attention-proxy", configResolved(viteConfig) {
    viteConfig.server.proxy = { "/es/api/attention": apiProxy(dashboard.url, "/es"), ...viteConfig.server.proxy }
  } }], uiPort)
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await context.route("**/*", (route) => new URL(route.request().url()).origin === uiOrigin ? route.continue() : route.abort())
  const page = await context.newPage()
  const answerInUi = async (id, text) => {
    await page.goto(uiOrigin)
    const card = page.locator(`[data-attention-id="${id}"]`)
    await card.getByRole("textbox", { name: /Your answer|Note/ }).fill(text)
    await card.getByRole("button", { name: "Send answer", exact: true }).click()
    await expect(page.locator(".home-notice")).toContainText("Answer saved")
  }

  // 1. Idle producer: the exact Fleet text reaches the next provider turn.
  const fleet = publish(sessionA, "issue:220:fleet-visualization:v1", "Choose a Fleet visualization direction")
  await answerInUi(fleet.id, FLEET)
  const stored = await ledger(fleet.id)
  assert.equal(stored.answer.text, FLEET)
  assert.equal(stored.answer.choice_id, null)
  const presented = await poll("idle presentation", async () => { const value = await ledger(fleet.id); return value.delivery_state === "presented" && value })
  assert(sawInProvider(FLEET), "provider turn must contain the verbatim answer")
  assert.equal(presented.delivery.session, sessionA)
  const mailId = presented.delivery.message_id
  const thread = (await readFile(path.join(root, ".es", "mail", "work.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(thread.filter((item) => item.request_id === presented.delivery.request_id).length, 1)
  record(`IDLE record=${fleet.id} mail=${mailId} session=${sessionA} state=presented providerCalls=${providerCalls.length}`)
  run(sessionA, ["mail", "ack", mailId, "--editspace", "fleet"])
  await poll("handled evidence", async () => (await ledger(fleet.id)).delivery_state === "handled")
  assert(run(sessionA, ["attention", "mine", "--editspace", "fleet"]).includes(`    ${FLEET}`))
  run(sessionA, ["attention", "resolve", fleet.id, "--editspace", "fleet", "--reason", "Pursuing A and C"])
  assert.equal((await ledger(fleet.id)).status, "resolved")
  record(`ACK producer es mail ack -> handled; es attention resolve -> resolved`)

  // 2. Busy producer: the answer steers in at the next provider-turn boundary.
  const busy = publish(sessionA, "issue:227:busy-case:v1", "Busy-case decision")
  hold = true
  assert.equal((await api("POST", `/session/${sessionA}/prompt_async`, { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "Long synthetic work" }] })).status, 204)
  await poll("held provider turn", () => held.length === 1)
  await answerInUi(busy.id, BUSY)
  const admitted = await poll("busy admission", async () => { const value = await ledger(busy.id); return ["admitted", "presented"].includes(value.delivery_state) && value })
  const inputs = (await api("GET", `/session/${sessionA}/input`)).body
  const steer = (inputs.items ?? inputs).find((item) => item.source?.id === admitted.delivery.message_id)
  assert.equal(steer.delivery, "steer")
  assert(!sawInProvider(BUSY), "busy answer must wait for the safe boundary")
  held.shift()()
  await poll("busy presentation", async () => (await ledger(busy.id)).delivery_state === "presented")
  assert(sawInProvider(BUSY))
  record(`BUSY record=${busy.id} delivery=steer presented after held turn released`)

  // 3. Verified successor: a real handoff fences A; the answer reaches only B.
  const late = publish(sessionA, "issue:227:successor-case:v1", "Successor-case decision")
  let receipt
  await poll("handoff completion", async () => {
    // Exit 3 means pending-safe-boundary; the same request ID resumes it.
    const result = spawnSync("python3", [es, "agent", "handoff", "work", "--editspace", "fleet", "--request-id", "e2e-handoff",
      "--brief", "Adopt outstanding attention records", "--task", "Continue"], { cwd: root, env: cliEnv(), encoding: "utf8", timeout: 60_000 })
    try { receipt = JSON.parse(result.stdout) } catch { receipt = { status: `error ${result.stderr}` } }
    if (receipt.status !== "completed") await sleep(500)
    return receipt.status === "completed"
  }, 60_000)
  const sessionB = receipt.successor
  assert.notEqual(sessionB, sessionA)
  assert(run(sessionB, ["attention", "mine", "--editspace", "fleet"]).includes(late.id), "successor adopts the outstanding record")
  const callsBefore = providerCalls.length
  await answerInUi(late.id, SUCCESSOR)
  const successor = await poll("successor presentation", async () => { const value = await ledger(late.id); return value.delivery_state === "presented" && value }, 60_000)
  assert.equal(successor.delivery.session, sessionB)
  assert.deepEqual(successor.delivery.copies.map((copy) => copy.session), [sessionB])
  assert(providerCalls.slice(callsBefore).some((body) => body.includes(SUCCESSOR)))
  const aInputs = (await api("GET", `/session/${sessionA}/input`)).body
  assert(!JSON.stringify(aInputs).includes(SUCCESSOR), "fenced predecessor must not receive the answer")
  record(`SUCCESSOR handoff ${sessionA} -> ${sessionB}; record=${late.id} presented to successor only`)

  // 4. A selected option alone is the answer: one delivery carrying the exact choice and no invented text.
  const mailFor = async (requestID) => (await readFile(path.join(root, ".es", "mail", "work.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((item) => item.request_id === requestID)
  const selectInUi = async (id, label, note) => {
    await page.goto(uiOrigin)
    const card = page.locator(`[data-attention-id="${id}"]`)
    await card.getByRole("radio", { name: label, exact: true }).check()
    if (note) await card.getByRole("textbox", { name: /Note/ }).fill(note)
    await card.getByRole("button", { name: `Send ${label}`, exact: true }).click()
  }
  const pick = publish(sessionB, "issue:238:selection-only:v1", "Selection-only decision")
  const pickCalls = providerCalls.length
  await selectInUi(pick.id, "C — Time weave")
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  const picked = await poll("selection presentation", async () => { const value = await ledger(pick.id); return value.delivery_state === "presented" && value }, 60_000)
  assert.equal(picked.answer.text, "")
  assert.equal(picked.answer.choice_id, "time-weave")
  assert.equal(picked.answer.revision, pick.revision)
  const [pickedMail] = await mailFor(picked.delivery.request_id)
  assert.equal((await mailFor(picked.delivery.request_id)).length, 1)
  assert(pickedMail.text.includes("Selected option: C — Time weave (time-weave)"))
  assert(pickedMail.text.includes("Written answer: none") && !pickedMail.text.includes("BEGIN ANSWER"), "no invented written text")
  assert(providerCalls.slice(pickCalls).some((body) => body.includes("Selected option: C — Time weave (time-weave)")), "the agent's turn sees the exact option")
  record(`SELECTION record=${pick.id} choice=time-weave text="" mail=1 presented to ${picked.delivery.session}`)

  // 5. Option plus a written note: both arrive verbatim in one delivery.
  const mixedRecord = publish(sessionB, "issue:238:selection-note:v1", "Selection with note")
  const NOTE = "B, but keep the legend from A"
  await selectInUi(mixedRecord.id, "B — Fleet orbit", NOTE)
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  const mixedDone = await poll("mixed presentation", async () => { const value = await ledger(mixedRecord.id); return value.delivery_state === "presented" && value }, 60_000)
  assert.equal(mixedDone.answer.choice_id, "fleet-orbit")
  assert.equal(mixedDone.answer.text, NOTE)
  assert(sawInProvider(NOTE) && providerCalls.some((body) => body.includes("Selected option: B — Fleet orbit (fleet-orbit)")))
  record(`MIXED record=${mixedRecord.id} choice=fleet-orbit + note delivered verbatim`)

  // 6. Unknown response: the exact command is retried; one answer, one mail, one delivery.
  const lost = publish(sessionB, "issue:238:lost-response:v1", "Lost-response decision")
  let drop = true
  await context.route("**/es/api/attention/*/commands?*", async (route) => {
    const response = await route.fetch()
    if (drop && response.status() === 200) { drop = false; await route.abort("failed"); return }
    await route.fulfill({ response })
  })
  await selectInUi(lost.id, "A — Project map")
  await expect(page.locator(".home-notice")).toContainText("Outcome unknown")
  await page.getByRole("button", { name: "Retry same action", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  await context.unroute("**/es/api/attention/*/commands?*")
  const lostDone = await poll("retried presentation", async () => { const value = await ledger(lost.id); return value.delivery_state === "presented" && value }, 60_000)
  assert.equal((await mailFor(lostDone.delivery.request_id)).length, 1)
  const lostEvents = (await (await fetch(`${dashboard.url}/api/attention/${lost.id}?es=fleet`)).json()).events
  assert.equal(lostEvents.filter((event) => event.action === "answer").length, 1)
  record(`RETRY record=${lost.id} lost response -> same command retried -> answers=1 mail=1`)

  // 7. RTL: the single primary action stays reachable without horizontal scroll.
  const rtl = publish(sessionB, "issue:238:rtl:v1", "قرار تجريبي")
  await page.goto(uiOrigin)
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const rtlCard = page.locator(`[data-attention-id="${rtl.id}"]`)
  await rtlCard.getByRole("radio", { name: "A — Project map", exact: true }).check()
  const button = await rtlCard.getByRole("button", { name: "Send A — Project map", exact: true }).boundingBox()
  assert(button && button.x >= 0 && button.x + button.width <= 1280, JSON.stringify(button))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  record(`RTL primary action at x=${Math.round(button.x)} width=${Math.round(button.width)}; no horizontal scroll`)

  const history = (await (await fetch(`${dashboard.url}/api/attention/${fleet.id}?es=fleet`)).json()).events
  record(`HISTORY ${history.map((event) => `${event.action}:${event.actor}${event.reason ? `(${event.reason})` : ""}`).join(" ")}`)
  record("PASS real private publish -> UI answer -> outbox -> mail -> runtime receipt -> provider read -> ack/resolve; idle, busy steer, verified successor, selection-only, option+note, lost-response retry, RTL")
} catch (error) {
  record(`FAIL ${error.stack ?? error}`)
  process.exitCode = 1
} finally {
  held.forEach((finish) => finish())
  await browser?.close()
  await preview?.close()
  // Each child leads its own process group, so uv's Python child is stopped with it.
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM") } catch {}
    await Promise.race([new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve)), sleep(5000)])
    try { process.kill(-child.pid, "SIGKILL") } catch {}
  }
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  const result = path.join(process.env.ATTENTION_E2E_RESULT_DIR ?? tmpdir(), `attention-answer-real-${process.pid}.log`)
  await writeFile(result, log.join("\n") + "\n")
  if (!process.env.ATTENTION_E2E_KEEP) await rm(home, { recursive: true, force: true })
  console.log(`RESULT ${result}`)
}

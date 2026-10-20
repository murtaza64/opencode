// Run from packages/es-app: INPUT_UPDATE_BINARY=/absolute/path bun test/input-update.real.mjs
// Private compiled backend, private DB, loopback gated fake provider; never contacts a real model.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import http from "node:http"
import net from "node:net"
import { access, mkdtemp, rm, stat } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { imageProviderConfig } from "../../opencode/test/fixture/input-image.ts"

const binary = process.env.INPUT_UPDATE_BINARY
assert(binary && path.isAbsolute(binary), "INPUT_UPDATE_BINARY must name an absolute compiled executable")
await access(binary, constants.X_OK)
const sha256 = createHash("sha256").update(Buffer.from(await Bun.file(binary).arrayBuffer())).digest("hex")
const home = await mkdtemp(path.join(tmpdir(), "input-update-real-"))
const db = path.join(home, "inputs.sqlite")
const results = []
const record = (message) => { results.push(message); console.log(message) }
const bounded = (name, promise, ms = 15000) => {
  const deadline = Promise.withResolvers()
  const timer = setTimeout(() => deadline.reject(new Error(`${name} timed out in ${ms}ms`)), ms)
  return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer))
}
const poll = async (name, fn, ms = 15000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`${name} timed out`)
}
const reservation = net.createServer()
await bounded("reserve port", new Promise((resolve, reject) => reservation.once("error", reject).listen(0, "127.0.0.1", resolve)))
const port = reservation.address().port
assert(port > 1024 && ![4096, 3181, 7777, 60302].includes(port))
const base = `http://127.0.0.1:${port}`
const socketOwner = (pid) => execFileSync("uv", ["run", "--with", "psutil", "python", "-c",
  "import psutil,sys; p=psutil.Process(int(sys.argv[1])); print(','.join(f'{c.laddr.ip}:{c.laddr.port}' for c in p.net_connections(kind='tcp') if c.status == 'LISTEN'))",
  String(pid)], { encoding: "utf8" })
const providerCalls = []
const gates = []
const provider = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  providerCalls.push(JSON.parse(Buffer.concat(chunks).toString()))
  response.writeHead(200, { "content-type": "text/event-stream" })
  gates.push(() => {
    if (response.writableEnded) return
    response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "synthetic" }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  })
})
let child
let output = ""
let diagnostics = ""
let stage = "setup"
try {
  await bounded("fake provider bind", new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve)))
  const config = imageProviderConfig(`http://127.0.0.1:${provider.address().port}/v1`)
  await bounded("release reserved backend port", new Promise((resolve) => reservation.close(resolve)))
  child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: home,
    env: {
      ...process.env, HOME: home, OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`,
      XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`,
      OPENCODE_DB: db, OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: `${home}/config/opencode`,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`, OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, server: { hostname: "127.0.0.1", port, mdns: false } }),
      OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
      OPENCODE_SERVER_PASSWORD: "", OPENCODE_PERMISSION: "{}",
    }, stdout: "pipe", stderr: "pipe",
  })
  const ready = Promise.withResolvers()
  void (async () => {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk)
      const match = output.match(/listening on (http:\/\/[^\s]+)/)
      if (match) ready.resolve(match[1])
    }
    ready.reject(new Error("Backend exited before ready"))
  })()
  void (async () => { for await (const chunk of child.stderr) diagnostics += new TextDecoder().decode(chunk) })()
  assert.equal(await bounded("backend listeningURL", ready.promise, 30000), base)
  const socket = socketOwner(child.pid)
  assert(socket.trim().split(",").includes(`127.0.0.1:${port}`), socket)
  assert.equal((await stat(db)).isFile(), true, `Expected private DB ${db} before application requests`)
  record(`ISOLATION binary=${binary} sha256=${sha256} PID=${child.pid} listeningURL=${base} socket=${socket.trim()} DB=${db} dbSize=${(await stat(db)).size}`)
  const request = async (method, route, body) => {
    const response = await bounded(`${method} ${route}`, fetch(`${base}${route}?directory=${encodeURIComponent(home)}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    }))
    return { status: response.status, body: await response.json() }
  }
  const ok = async (method, route, body) => {
    const result = await request(method, route, body)
    assert.equal(result.status, 200, JSON.stringify(result))
    return result.body
  }
  stage = "provider boundary"
  const session = await ok("POST", "/session", { title: "Private input update", agent: "build", model: { id: "test-model", providerID: "test" } })
  const root = `/session/${session.id}`
  assert.equal((await request("POST", `${root}/prompt_async`, { agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text: "Initial synthetic turn" }] })).status, 204)
  await poll("first gated provider request", () => gates.length === 1)
  const image = { type: "file", mime: "image/png", filename: "fixture.png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AH8A//8E/gJ++9d/DQAAAABJRU5ErkJggg==" }
  const a = { requestID: "update-a", delivery: "queue", text: "original A", images: [image] }
  const b = { requestID: "update-b", delivery: "steer", text: "original B" }
  const admissionA = await ok("POST", `${root}/input`, a)
  const admissionB = await ok("POST", `${root}/input`, b)
  assert.equal(admissionA.state, "pending")
  assert.equal(admissionB.state, "pending")
  const patchA = `${root}/input/${a.requestID}`
  const patchB = `${root}/input/${b.requestID}`
  stage = "concurrent HTTP CAS"
  const edits = [
    { commandID: "client-one", expectedRevision: 0, text: "alpha", delivery: "steer" },
    { commandID: "client-two", expectedRevision: 0, text: "beta", delivery: "steer" },
  ]
  const replies = await Promise.all(edits.map((edit) => request("PATCH", patchA, edit)))
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409])
  const winner = replies.findIndex((reply) => reply.status === 200)
  const updatedA = replies[winner].body
  assert.deepEqual(replies[1 - winner].body.current, updatedA)
  assert.equal(updatedA.revision, 1)
  assert.equal(updatedA.delivery, "steer")
  assert.equal(updatedA.admittedSeq, admissionA.admittedSeq)
  assert.deepEqual(updatedA.images, admissionA.images)
  assert.deepEqual(await ok("PATCH", patchA, edits[winner]), updatedA)
  const changed = await request("PATCH", patchA, { ...edits[winner], text: "different" })
  assert.equal(changed.status, 409)
  assert.deepEqual(changed.body.current, updatedA)
  const updatedB = await ok("PATCH", patchB, { commandID: "defer-b", expectedRevision: 0, delivery: "queue" })
  assert.equal(updatedB.delivery, "queue")
  assert.equal(updatedB.text, b.text)
  assert.equal(updatedB.admittedSeq, admissionB.admittedSeq)
  const retriedA = await ok("POST", `${root}/input`, a)
  const retriedB = await ok("POST", `${root}/input`, b)
  assert.deepEqual({ ...retriedA, wakeObservations: undefined }, { ...updatedA, wakeObservations: undefined })
  assert.deepEqual({ ...retriedB, wakeObservations: undefined }, { ...updatedB, wakeObservations: undefined })
  assert.deepEqual(retriedA.wakeObservations.slice(0, -1), updatedA.wakeObservations)
  assert.deepEqual(retriedB.wakeObservations.slice(0, -1), updatedB.wakeObservations)
  assert.equal((await request("POST", `${root}/input`, { ...a, text: "changed admission" })).status, 409)
  record(`CAS session=${session.id} winner=${edits[winner].commandID} losing409/current; exactRetry200; edited admission retry stable; A queue->steer, B steer->queue`)
  stage = "promotion race"
  gates[0]()
  await poll("A promotion", async () => (await ok("GET", patchA)).state === "promoted")
  const promotedA = await ok("GET", patchA)
  assert.equal(promotedA.revision, 1)
  assert.equal(promotedA.text, updatedA.text)
  assert.equal((await ok("GET", patchB)).state, "pending")
  const late = await request("PATCH", patchA, { commandID: "late-edit", expectedRevision: 1, text: "too late" })
  assert.equal(late.status, 409)
  assert.deepEqual(late.body.current, promotedA)
  assert.deepEqual(await ok("PATCH", patchA, edits[winner]), updatedA)
  await poll("second provider turn", () => gates.length === 2)
  assert.equal((await ok("GET", patchB)).state, "pending")
  const firstMessages = await ok("GET", `${root}/message`)
  const visibleA = firstMessages.filter((item) => item.info.role === "user" && item.parts.some((part) => part.type === "text" && part.text === updatedA.text))
  assert.equal(visibleA.length, 1)
  assert.equal(visibleA[0].info.model.providerID, "test")
  assert.equal(visibleA[0].info.model.modelID, "test-model")
  assert.equal(visibleA[0].parts.filter((part) => part.type === "file").length, 1)
  assert(JSON.stringify(providerCalls[1]).includes(updatedA.text), "second provider turn must see edited A")
  assert(!JSON.stringify(providerCalls[1]).includes(b.text), "second provider turn must not see deferred B")
  assert(JSON.stringify(providerCalls[1]).includes("image_url"), "second provider turn must include admitted image")
  record(`BOUNDARY A promoted revision=1 message=${promotedA.messageID} imageParts=1 model=test/test-model; stale409/current; B remains pending during provider turn 2`)
  gates[1]()
  await poll("B idle promotion", async () => (await ok("GET", patchB)).state === "promoted")
  const promotedB = await ok("GET", patchB)
  await poll("third provider turn", () => gates.length === 3)
  gates[2]()
  await poll("third turn finished", async () => (await ok("GET", `${root}/message`)).filter((item) => item.info.role === "assistant" && item.info.finish === "stop").length === 3)
  const visible = (await ok("GET", `${root}/message`)).filter((item) => item.info.role === "user")
  assert.equal(visible.filter((item) => item.parts.some((part) => part.type === "text" && part.text === updatedA.text)).length, 1)
  assert.equal(visible.filter((item) => item.parts.some((part) => part.type === "text" && part.text === b.text)).length, 1)
  assert.equal(providerCalls.length, 3)
  assert(JSON.stringify(providerCalls[2]).includes(b.text), "third provider turn must see idle-promoted B")
  assert.equal((await ok("GET", patchA)).messageID, promotedA.messageID)
  assert.equal((await ok("GET", patchB)).messageID, promotedB.messageID)
  record(`PASS B idle promotion message=${promotedB.messageID}; visible A=1 B=1 providerCalls=${providerCalls.length} session=${session.id}`)
} catch (error) {
  record(`FAIL stage=${stage} ${error.stack ?? error} stdout=${output.slice(-4000)} stderr=${diagnostics.slice(-4000)}`)
  process.exitCode = 1
} finally {
  gates.forEach((gate) => gate())
  if (child) {
    child.kill()
    await bounded("backend exit", child.exited, 5000).catch(async () => {
      child.kill("SIGKILL")
      await bounded("backend forced exit", child.exited, 5000)
    })
    const probe = net.createServer()
    await bounded("verify backend port released", new Promise((resolve, reject) => probe.once("error", reject).listen(port, "127.0.0.1", resolve)))
    await bounded("release cleanup probe", new Promise((resolve) => probe.close(resolve)))
  }
  provider.closeAllConnections()
  await bounded("provider exit", new Promise((resolve) => provider.close(resolve)), 5000)
  if (reservation.listening) await bounded("reservation close", new Promise((resolve) => reservation.close(resolve)), 5000)
  await rm(home, { recursive: true, force: true })
  record(`CLEANUP backendPID=${child?.pid} port=${port} privateDB=${db} removed listener=gone`)
  const result = path.join(process.env.INPUT_UPDATE_RESULT_DIR ?? tmpdir(), `input-update-${child?.pid ?? "startup"}.log`)
  await Bun.write(result, results.join("\n") + "\n")
  console.log(`RESULT ${result}`)
}

// From packages/es-app: HARNESS_BINARY=/absolute/opencode bun test/harness-perf.real.mjs
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"

const binary = process.env.HARNESS_BINARY
assert(binary && path.isAbsolute(binary), "Set HARNESS_BINARY to a compiled executable")
const home = await mkdtemp(path.join(tmpdir(), "harness-perf-"))
const db = path.join(home, "core.sqlite")
const adapter = process.env.HARNESS_OPENROUTER === "1" ? "@openrouter/ai-sdk-provider" : "@ai-sdk/openai-compatible"
const v2 = process.env.HARNESS_V2 === "1"
const password = v2 ? randomUUID() : undefined
const calls = []
const tool = { id: "call_fixture", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf HARNESS_FIXTURE", description: "Print fixture", timeout: 1000 }) } }
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
  const body = await request.json()
  const result = body.messages.findLast(message => message.role === "tool")
  calls.push({ at: performance.now(), bytes: JSON.stringify(body).length, result: result?.content, model: body.model })
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "fixture", model: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  return new Response(chunk({ role: "assistant", ...(result ? { content: "READY" } : { tool_calls: [{ ...tool, index: 0 }] }) }) + chunk({}, result ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port
await reserve.stop(true)
const base = `http://127.0.0.1:${port}`
const config = { model: "fixture/fixture", enabled_providers: ["fixture"], agent: { build: { permission: { "*": "deny", bash: "allow" } } },
  provider: { fixture: { npm: adapter, name: "Fixture", options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" }, models: { fixture: { name: "Fixture", tool_call: true, limit: { context: 200000, output: 1024 } } } } } }
const started = performance.now()
const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: home, stdout: "pipe", stderr: "ignore", env: {
  PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`, XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`,
  OPENCODE_DB: db, OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`, OPENCODE_AUTH_CONTENT: "{}", OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_PURE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  ...(process.env.HARNESS_SQLITE_WORKER === "1" ? { OPENCODE_DB_WRITER_WORKER: "1" } : {}),
  ...(password ? { OPENCODE_PASSWORD: password } : {}),
} })
const api = async (route, body) => {
  const response = await fetch(`${base}${route}?directory=${encodeURIComponent(home)}`, { signal: AbortSignal.timeout(v2 ? 30000 : 10000), headers: { "content-type": "application/json", ...(password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}) }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) }).catch(error => { throw Error(`${route}: ${error.name}`) })
  assert(response.ok, `${route}: HTTP ${response.status}`)
  return response.json()
}
const within = async (promise, ms, fallback) => {
  let timer
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms) })])
  } finally { clearTimeout(timer) }
}
try {
  const ready = new Promise(async (resolve, reject) => {
    let text = ""
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk)
      const url = text.match(/listening on (http:\/\/[^\s]+)/)?.[1]
      if (url) resolve(url)
    }
    reject(Error("Backend exited before listener readiness"))
  })
  assert.equal(await within(ready, 45000, "timeout"), base)
  const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof"
  const sockets = () => execFileSync(lsof, ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim()
  assert.equal(sockets(), String(child.pid))
  assert(execFileSync(lsof, ["-p", String(child.pid), "-Fn"], { encoding: "utf8" }).split("\n").includes(`n${await realpath(db)}`), "Child must use the disposable DB")
  console.log(JSON.stringify({ listenerMs: Math.round(performance.now() - started) }))
  if (process.env.HARNESS_SSE_CHURN === "1") {
    for (const route of ["/global/event", "/event"]) for (let index = 0; index < 8; index++) {
      const abort = new AbortController()
      const response = await fetch(`${base}${route}?directory=${encodeURIComponent(home)}`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })
      assert.equal(response.status, 200)
      const reader = response.body.getReader()
      try {
        assert.match(new TextDecoder().decode((await reader.read()).value), /server.connected/)
      } finally { abort.abort(); await reader.cancel().catch(() => {}) }
    }
    // A leaked subscription retains its event listener after the socket closes.
    const logdir = path.join(home, "data/opencode/log")
    const { readdir } = await import("node:fs/promises")
    const deadline = performance.now() + 3500
    let disconnected = 0
    let globalDisconnected = 0
    do {
      const names = (await readdir(logdir)).filter(name => name.endsWith(".log"))
      const logs = await Promise.all(names.map(name => readFile(path.join(logdir, name), "utf8")))
      const text = logs.join("\n")
      globalDisconnected = text.match(/global event disconnected/g)?.length ?? 0
      disconnected = text.match(/(?<!global )event disconnected/g)?.length ?? 0
      if (disconnected === 8 && globalDisconnected === 8) break
      await Bun.sleep(100)
    } while (performance.now() < deadline)
    assert.equal(globalDisconnected, 8, "All disconnected global SSE subscriptions must finalize")
    assert.equal(disconnected, 8, "All disconnected instance SSE subscriptions must finalize")
    console.log("PASS: eight global and eight instance SSE connect/disconnect cycles finalize")
  }
  if (v2) {
    await api("/api/location")
    const { data: session } = await api("/api/session", { title: "Synthetic v2 inbox parity", location: { directory: await realpath(home) } })
    const route = `/api/session/${session.id}`
   const payload = { text: "Synthetic admit-only input", resume: false }
   const { data: input } = await api(`${route}/prompt`, payload)
   assert.equal(typeof input.id, "string")
   assert.deepEqual((await api(`${route}/prompt`, { ...payload, id: input.id })).data, input)
   const conflict = await api(`${route}/prompt`, { ...payload, id: input.id, text: "Conflicting retry" }).then(
     result => { assert.deepEqual(result.data, input); return "existing input returned" },
     error => { assert.match(error.message, /HTTP 409/); return "rejected" },
   )
    const { data: inbox } = await api(`${route}/inbox`)
    assert.equal(inbox.length, 1)
    assert.deepEqual(inbox[0], input)
    assert.equal(calls.length, 0, "Admit-only input must not reach the provider")
    const cancel = await fetch(`${base}${route}/inbox/${encodeURIComponent(input.id)}`, {
      method: "DELETE", headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(10000),
    })
    assert.equal(cancel.status, 204)
    assert.deepEqual((await api(`${route}/inbox`)).data, [])
    assert.equal(calls.length, 0)
    console.log(JSON.stringify({ v2: "durable inbox, exact retry, and cancellation without dispatch", conflictingRetry: conflict }))
  } else {
  if (process.env.HARNESS_SQLITE_PROBE === "1") {
    const session = await api("/session", { title: "Disposable SQLite contention fixture" })
    const lock = new Database(db)
    lock.exec("BEGIN IMMEDIATE")
    const start = performance.now()
    let locked = true
    const unlock = () => { if (locked) { lock.exec("ROLLBACK"); locked = false } }
    const deadline = setTimeout(unlock, 3000)
    try {
      const admission = api(`/session/${session.id}/input`, { requestID: "sqlite-probe", delivery: "steer", text: "Synthetic lock probe" }).then(() => Math.round(performance.now() - start))
      await Bun.sleep(250)
      const healthStart = performance.now()
      await api("/global/health")
      const healthMs = Math.round(performance.now() - healthStart)
      const healthWhileLocked = locked
      unlock()
      console.log(JSON.stringify({ healthMs, healthWhileLocked, admissionMs: await admission }))
      if (process.env.HARNESS_SQLITE_ASSERT === "1") assert(healthWhileLocked, "Core health must respond before releasing the independent SQLite writer lock")
    } finally { clearTimeout(deadline); unlock(); lock.close() }
    while (performance.now() - start < 10000) {
      if ((await api(`/session/${session.id}/message`)).some(message => message.info.time.completed && message.parts.some(part => part.type === "text" && part.text === "READY"))) break
      await Bun.sleep(50)
    }
  }
  for (const [name, lines] of [[calls.length ? "post-lock lean" : "cold lean", 0], ["warm lean", 0], ["warm long", 4500], ["warm lean repeat", 0]]) {
    const session = await api("/session", { title: "Synthetic performance fixture" })
    const before = calls.length
    const start = performance.now()
    await api(`/session/${session.id}/input`, { requestID: `fixture-${before}`, delivery: "steer", text: `Run the fixture once and report READY.\n${"Synthetic ledger: amber 3; cedar 11. Ignore.\n".repeat(lines)}` })
    const deadline = start + 45000
    let reply
    while (performance.now() < deadline) {
      reply = (await api(`/session/${session.id}/message`)).find(message => message.info.time.completed && message.parts.some(part => part.type === "text" && part.text === "READY"))
      if (reply) break
      await Bun.sleep(25)
    }
    const span = calls.slice(before)
    assert.equal(span.length, 2, `${name}: expected tool call and continuation, with no retries`)
    assert(span.every(call => call.model === "fixture"))
    assert(JSON.stringify(span[1].result).includes("HARNESS_FIXTURE"), `${name}: tool result missing`)
    assert(reply, `${name}: continuation did not finish`)
    if (lines) assert(span[0].bytes > 150000, "Long context must reach the provider")
    const dispatchMs = Math.round(span[0].at - start)
    console.log(JSON.stringify({ name, dispatchMs, continuationMs: Math.round(span[1].at - span[0].at), observedFinishMs: Math.round(performance.now() - start), bytes: span[0].bytes }))
    assert(dispatchMs < (lines ? 10000 : name === "cold lean" ? 40000 : 5000), `${name}: dispatch budget exceeded (${dispatchMs}ms)`)
  }
  if (process.env.HARNESS_SQLITE_ASSERT === "1") {
    const session = await api("/session", { title: "Disposable failed write fixture" })
    const sqlite = new Database(db)
    const route = `/session/${session.id}/input`
    const payload = { requestID: "fixture-write-recovery", delivery: "steer", text: "Synthetic failed write" }
    try {
      sqlite.exec("CREATE TRIGGER fail_fixture_input BEFORE INSERT ON v1_session_input BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END")
      const before = calls.length
      await assert.rejects(api(route, payload), /HTTP 5\d\d/)
      assert.equal(calls.length, before, "A failed admission must not dispatch")
      const missing = await fetch(`${base}${route}/${payload.requestID}?directory=${encodeURIComponent(home)}`, { signal: AbortSignal.timeout(5000) })
      assert.equal(missing.status, 404, "Failed write must not leave an input receipt")
      sqlite.exec("DROP TRIGGER fail_fixture_input")
      const admitted = await api(route, payload)
      assert.equal(admitted.requestID, payload.requestID)
      const retry = await api(route, payload)
      assert.equal(retry.admittedSeq, admitted.admittedSeq, "An exact retry must preserve admission identity")
      const deadline = performance.now() + 10000
      let done = false
      while (!done && performance.now() < deadline) {
        done = (await api(`/session/${session.id}/message`)).some(message => message.info.time.completed && message.parts.some(part => part.type === "text" && part.text === "READY"))
        if (!done) await Bun.sleep(25)
      }
      assert(done, "Recovered admission must complete its tool round trip")
      assert.equal(calls.length - before, 2, "Failed write plus exact retry must produce only one tool round trip")
      console.log("PASS: failed admission leaves no receipt or dispatch; exact retry completes once")
    } finally { sqlite.close() }
  }
  if (process.env.HARNESS_SQLITE_LOAD === "1") {
    const sessions = []
    for (let index = 0; index < 12; index++) sessions.push(await api("/session", { title: "Concurrent synthetic admission" }))
    const before = calls.length
    const started = performance.now()
    const latencies = await Promise.all(sessions.map(async (session, index) => {
      const start = performance.now()
      const receipt = await api(`/session/${session.id}/input`, { requestID: `fixture-concurrent-${index}`, delivery: "steer", text: "Run the fixture and report READY." })
      assert.equal(receipt.requestID, `fixture-concurrent-${index}`)
      return performance.now() - start
    }))
    const deadline = started + 15000
    const pending = new Set(sessions.map(session => session.id))
    while (pending.size && performance.now() < deadline) {
      await Promise.all([...pending].map(async id => {
        const messages = await api(`/session/${id}/message`)
        if (!messages.some(message => message.info.time.completed && message.parts.some(part => part.type === "text" && part.text === "READY"))) return
        assert.equal(messages.filter(message => message.info.role === "user").length, 1)
        pending.delete(id)
      }))
      if (pending.size) await Bun.sleep(50)
    }
    assert.equal(pending.size, 0, "All concurrent admissions must finish")
    assert.equal(calls.length - before, sessions.length * 2)
    console.log(JSON.stringify({ concurrentSessions: sessions.length, admissionMs: latencies.map(Math.round).sort((a, b) => a - b), allFinishedMs: Math.round(performance.now() - started) }))
  }
  if (process.env.HARNESS_COMPARE_CLIENTS === "1") {
    const before = calls.length
    const runner = Bun.spawn(["node", path.join(import.meta.dirname, "compare-clients.mjs"), base, home, binary], { stdout: "inherit", stderr: "inherit" })
    const result = await within(runner.exited, 100000, null)
    if (result === null) runner.kill()
    assert.equal(result, 0, "Client comparison did not complete")
    assert.equal(calls.length - before, 8, "Each client must make exactly two provider calls per round trip")
  }
  if (process.env.HARNESS_TURN_TRACE === "1") {
    const logfile = path.join(home, "data/opencode/log/diagnostics.jsonl")
    const deadline = performance.now() + 7000
    let traces = []
    let preparations = []
    do {
      const rows = (await readFile(logfile, "utf8").catch(() => "")).trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line))
      traces = rows.filter(row => row.type === "provider-turn")
      preparations = rows.filter(row => row.type === "turn-preparation")
      if (traces.length >= 8 && (process.env.HARNESS_PREP_TRACE !== "1" || preparations.length >= 8)) break
      await Bun.sleep(100)
    } while (performance.now() < deadline)
    assert.equal(traces.length, 8, "Each tool and continuation step must emit exactly one trace")
    for (const row of traces) {
      assert.equal(row.attempts, 1)
      assert(row.modelInitMs + row.prepareMs <= row.dispatchMs)
      assert(row.dispatchMs <= row.streamReadyMs && row.streamReadyMs <= row.elapsedMs)
      assert(!("prompt" in row) && !("headers" in row) && !("text" in row))
    }
    assert.equal(traces.filter(row => row.firstTextMs !== undefined).length, 4)
    assert(traces.every(row => row.firstTextMs === undefined || (row.firstTextMs >= row.streamReadyMs && row.elapsedMs >= row.firstTextMs)))
    if (process.env.HARNESS_PREP_TRACE === "1") {
      assert.equal(preparations.length, 8)
      for (const [index, row] of preparations.entries()) {
        assert.equal(row.inputID, traces[index].inputID)
        assert.equal(row.sessionID, traces[index].sessionID)
        const phases = [row.snapshotMs, row.toolsMs, row.summaryMs, row.hooksMs, row.contextMs]
        assert(phases.every(ms => Number.isInteger(ms) && ms >= 0))
        assert(Math.abs(phases.reduce((sum, ms) => sum + ms, 0) - row.elapsedMs) <= 4)
        console.log(JSON.stringify({ preparation: index, snapshot: row.snapshotMs, tools: row.toolsMs, summary: row.summaryMs, hooks: row.hooksMs, context: row.contextMs }))
      }
    }
    console.log("PASS: provider-turn diagnostics separate preparation, provider stream readiness, and first nonempty text")
  }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  child.kill()
  if (await within(child.exited, 3000, null) === null) { child.kill("SIGKILL"); await within(child.exited, 3000, null) }
  assert.equal(await fetch(base, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false), false, "Fixture listener must close")
  await provider.stop(true)
  await rm(home, { recursive: true, force: true })
}

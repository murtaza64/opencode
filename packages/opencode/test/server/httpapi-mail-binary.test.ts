import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database as Sqlite } from "bun:sqlite"
import { testProviderConfig } from "../lib/test-provider"

const binary = process.env.ES_MAIL_TEST_BINARY
const cli = process.env.ES_MAIL_TEST_CLI
if (!binary || !cli) test.skip("candidate binary mail wake (set ES_MAIL_TEST_BINARY and ES_MAIL_TEST_CLI)", () => {})
else test("compiled candidate serves private mail wake receipts", async () => {
  expect(path.isAbsolute(binary)).toBe(true)
  expect(path.isAbsolute(cli)).toBe(true)
  const candidate = await stat(binary)
  expect(candidate.isFile()).toBe(true)
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(binary)) hash.update(chunk)
  const sha256 = hash.digest("hex")
  const root = await mkdtemp(path.join(tmpdir(), "opencode-mail-candidate-"))
  const home = path.join(root, "home")
  const editspaces = path.join(root, "editspaces")
  const editspace = path.join(editspaces, "private")
  const receiver = path.join(editspace, "lanes", "receiver")
  const db = path.join(root, "runtime.sqlite3")
  const recordDir = process.env.ES_MAIL_TEST_RECORD_DIR ?? path.dirname(root)
  const record = path.join(recordDir, `mail-candidate-${process.pid}-${Date.now()}`)
  const log = `${record}.log`
  const sockets: Array<ReturnType<typeof createServer>> = []
  let child: ReturnType<typeof Bun.spawn> | undefined
  let output: Awaited<ReturnType<typeof open>> | undefined
  let selectedPort: number | undefined
  let activeSession: string | undefined
  let gate: string | undefined
  let completed: { session: string; idle: string; active: string; retry: string; providerRequests: number } | undefined
  try {
    await Promise.all([mkdir(home, { recursive: true }), mkdir(receiver, { recursive: true }),
      mkdir(recordDir, { recursive: true }), mkdir(path.join(root, "tmp"), { recursive: true })])
    const trap = createServer((_req, res) => { hits++; res.writeHead(503).end() })
    let hits = 0
    sockets.push(trap)
    await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve))
    const trapAddress = trap.address()
    if (!trapAddress || typeof trapAddress === "string") throw new Error("trap must be loopback TCP")
    const config = { ...testProviderConfig(`http://127.0.0.1:${trapAddress.port}/v1`), plugin: [] }
    await writeFile(path.join(receiver, "opencode.json"), JSON.stringify(config))
    // Reserve an ephemeral port, release it, then pass its nonzero value explicitly.
    // A bind race is a failure, never a fallback to a live/default server.
    const reservation = createServer()
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
    const address = reservation.address()
    if (!address || typeof address === "string" || address.port <= 0) throw new Error("no private TCP port")
    const port = address.port
    selectedPort = port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const url = `http://127.0.0.1:${port}`
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DB: db, OPENCODE_DISABLE_SHARE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      EDITSPACES_ROOT: editspaces, REPO_CACHE_ROOT: path.join(root, "cache"),
      EDITSPACE_AGENT_ID: "test-agent", OPENCODE_URL: url,
      UV_PROJECT_ENVIRONMENT: path.join(root, "venv"), UV_CACHE_DIR: path.join(root, "uv-cache"),
      UV_FROZEN: "1",
    }
    output = await open(log, "w")
    child = Bun.spawn({ cmd: [binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: receiver, env, stdout: output.fd, stderr: output.fd })
    expect(child.pid).toBeGreaterThan(0)
    const pid = child.pid
    const api = async (route: string, init: RequestInit = {}, target = url) => {
      const response = await fetch(new URL(route, target), {
        ...init, headers: { "x-opencode-directory": receiver, ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers }, signal: AbortSignal.timeout(10_000),
      })
      const body: unknown = await response.json()
      return { status: response.status, body }
    }
    const deadline = Date.now() + 20_000
    while (true) {
      if (Date.now() > deadline) throw new Error(`candidate did not start: ${await readFile(log, "utf8")}`)
      if (child.exitCode !== null) throw new Error(`candidate exited: ${await readFile(log, "utf8")}`)
      if ((await readFile(log, "utf8")).includes(`server listening on ${url}`)) break
      await Bun.sleep(100)
    }
    expect(await readFile(log, "utf8")).toContain(`server listening on ${url}`)
    const processInfo = Bun.spawnSync(["ps", "-p", String(pid), "-o", "pid=", "-o", "command="])
    expect(processInfo.exitCode).toBe(0)
    expect(new TextDecoder().decode(processInfo.stdout)).toContain(`${pid} ${binary} serve`)
    const listener = Bun.spawnSync([process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"])
    expect(listener.exitCode).toBe(0)
    const ownership = new TextDecoder().decode(listener.stdout)
    expect(ownership).toContain(`p${pid}\n`)
    expect(ownership).toContain(`n127.0.0.1:${port}\n`)
    const files = Bun.spawnSync([process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      "-nP", "-a", "-p", String(pid), "-Fn"])
    expect(files.exitCode).toBe(0)
    expect(new TextDecoder().decode(files.stdout)).toContain(`n${db}\n`)
    const identity = new Sqlite(db, { readonly: true })
    try { expect(identity.query("PRAGMA database_list").all()).toContainEqual(expect.objectContaining({ file: db })) }
    finally { identity.close() }
    await writeFile(`${record}.json`, JSON.stringify({ binary, sha256, pid, url, db, log, root }) + "\n")

    const created = await api("/session", { method: "POST", body: JSON.stringify({
      title: "Private binary mail", agent: "build", model: { providerID: "test", id: "test-model" },
    }) })
    expect(created.status).toBe(200)
    if (typeof created.body !== "object" || !created.body || !("id" in created.body) ||
      typeof created.body.id !== "string") throw new Error("session identity missing")
    const session = created.body.id
    activeSession = session
    await writeFile(path.join(receiver, "LANE.md"), `# Lane: receiver\nowner: ${session}\nstatus: active\n`)
    const seeded = await api(`/session/${session}/message`, { method: "POST", body: JSON.stringify({
      agent: "build", model: { providerID: "test", modelID: "test-model" }, noReply: true,
      parts: [{ type: "text", text: "Unfinished turn; advisory wakes must not call the provider" }],
    }) })
    expect(seeded.status).toBe(200)
    const history = await api(`/session/${session}/message`)
    expect(history.status).toBe(200)
    expect(history.body).toMatchObject([{ info: { role: "user", model: {
      providerID: "test", modelID: "test-model" } } }])
    if (!Array.isArray(history.body)) throw new Error("session history missing")
    expect(history.body).toHaveLength(1)
    const conn = new Sqlite(db, { readonly: true })
    try {
      expect(conn.query("PRAGMA database_list").all()).toContainEqual(expect.objectContaining({ file: db }))
      expect(conn.query("SELECT id, directory FROM session WHERE id = ?").get(session))
        .toMatchObject({ id: session, directory: receiver })
    } finally { conn.close() }

    const send = async (id: string, target = url) => {
      const proc = Bun.spawn({ cmd: ["uv", "run", "--no-project", "--script", "--quiet", cli,
        "--editspace", "private", "mail", "send", "--kind", "task", "--to", "receiver",
        "--request-id", id, "--json", "Private task"], cwd: editspace,
        env: { ...env, OPENCODE_URL: target }, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(20_000) })
      const [text, errors, exit] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ])
      expect(exit, errors).toBe(0)
      const result: unknown = JSON.parse(text)
      if (typeof result !== "object" || !result || !("deliveries" in result) ||
        !Array.isArray(result.deliveries) || !("id" in result) || typeof result.id !== "string")
        throw new Error("CLI did not return a mail receipt")
      const row = result.deliveries[0]
      if (!row || typeof row.request_id !== "string" || row.session !== session)
        throw new Error("CLI receipt has no private recipient identity")
      return { id: result.id, delivery: row as { request_id: string; state: string; session: string; wake_observations?: unknown[] } }
    }
    const read = async (id: string) => {
      const result = await api(`/session/${session}/input/${id}`)
      expect(result.status).toBe(200)
      return result.body
    }
    const first = await send("idle")
    expect(first.delivery.state).toBe("admitted")
    const idle = await read(first.delivery.request_id)
    expect(idle).toMatchObject({ requestID: first.delivery.request_id, state: "pending",
      source: { type: "editspace-mail", id: first.id, recipient: "receiver" },
       wakeObservations: [{ outcome: "scheduled", observedAt: expect.any(Number) }] })
     expect(first.delivery.wake_observations).toMatchObject([{ outcome: "scheduled", observedAt: expect.any(Number) }])
    expect(await read(first.delivery.request_id)).toEqual(idle)
    expect(hits).toBe(0)

    // Hold a real shell request at a private file gate. Abort while held so
    // neither the shell nor queued mail can cause provider continuation.
    gate = path.join(root, "shell-release")
    const shell = fetch(`${url}/session/${session}/shell?directory=${encodeURIComponent(receiver)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "build", command: `while test ! -f '${gate}'; do sleep 0.05; done` }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined)
    const busyDeadline = Date.now() + 15_000
    while (true) {
      if (Date.now() > busyDeadline) throw new Error("private shell never became busy")
      const status = await api(`/session/status?directory=${encodeURIComponent(receiver)}`)
      if (JSON.stringify(status.body).includes(`"${session}":{"type":"busy"`)) break
      await Bun.sleep(50)
    }
    const active = await send("active")
    expect(active.delivery.state).toBe("admitted")
     expect(await read(active.delivery.request_id)).toMatchObject({ state: "pending",
       wakeObservations: [{ outcome: "coalesced", observedAt: expect.any(Number) }] })
     expect(active.delivery.wake_observations).toMatchObject([{ outcome: "coalesced", observedAt: expect.any(Number) }])
    expect(hits).toBe(0)

    let dropped = false
    const proxy = createServer(async (req, res) => {
      const body = Buffer.concat(await Array.fromAsync(req))
      const response = await fetch(new URL(req.url ?? "/", url), {
        method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body: req.method === "POST" ? body : undefined,
      })
      if (req.method === "POST" && !dropped && req.url?.includes("/input?")) {
        dropped = true
        req.socket.destroy()
        return
      }
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    })
    sockets.push(proxy)
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy must be loopback TCP")
    const lost = await send("lost-ack", `http://127.0.0.1:${proxyAddress.port}`)
    expect(dropped).toBe(true)
     expect(lost.delivery.state).toBe("failed")
     expect(lost.delivery.wake_observations).toBeUndefined()
    const committed = await read(lost.delivery.request_id)
    expect(committed).toMatchObject({ wakeObservations: [{ outcome: "coalesced" }] })
    const retry = await send("lost-ack")
    expect(retry).toMatchObject({ id: lost.id, delivery: { request_id: lost.delivery.request_id, state: "admitted" } })
    const recovered = await read(lost.delivery.request_id)
    expect(recovered).toMatchObject({ wakeObservations: [
      { outcome: "coalesced", observedAt: expect.any(Number) },
      { outcome: "coalesced", observedAt: expect.any(Number) },
    ] })
    if (typeof committed !== "object" || !committed || !("wakeObservations" in committed) ||
      typeof recovered !== "object" || !recovered || !("wakeObservations" in recovered) ||
      !Array.isArray(recovered.wakeObservations) || !Array.isArray(committed.wakeObservations))
      throw new Error("missing wake history")
     expect(recovered.wakeObservations[0]).toEqual(committed.wakeObservations[0])
     expect(retry.delivery.wake_observations).toEqual(recovered.wakeObservations)
    expect(await read(lost.delivery.request_id)).toEqual(recovered)
    expect(hits).toBe(0)
    expect((await readFile(path.join(editspace, ".es", "mail", "receiver.jsonl"), "utf8")).trim().split("\n"))
      .toHaveLength(3)
    await api(`/session/${session}/abort`, { method: "POST" })
    await Promise.race([shell, Bun.sleep(5_000).then(() => { throw new Error("shell did not settle on abort") })])
    expect(hits).toBe(0)
    completed = { session, idle: first.delivery.request_id, active: active.delivery.request_id,
      retry: retry.delivery.request_id, providerRequests: hits }
  } finally {
    // Never release the gate before stopping the child: completion could resume a model turn.
    if (child) {
      if (activeSession && selectedPort) await fetch(`http://127.0.0.1:${selectedPort}/session/${activeSession}/abort?directory=${encodeURIComponent(receiver)}`, {
        method: "POST", signal: AbortSignal.timeout(1_000),
      }).catch(() => undefined)
      child.kill("SIGTERM")
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(3_000).then(() => false)])
      if (!stopped) {
        child.kill("SIGKILL")
        if (!(await Promise.race([child.exited.then(() => true), Bun.sleep(3_000).then(() => false)])))
          throw new Error(`candidate PID ${child.pid} did not stop`)
      }
    }
    if (gate) await writeFile(gate, "released after candidate stopped\n")
    if (selectedPort) {
      const listener = Bun.spawnSync([process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
        "-nP", "-iTCP:" + selectedPort, "-sTCP:LISTEN", "-Fpn"])
      expect(listener.exitCode).toBe(1)
    }
    await Promise.all(sockets.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })))
    await output?.close()
    await rm(root, { recursive: true, force: true })
    await writeFile(`${record}.json`, JSON.stringify({ binary, sha256, pid: child?.pid,
      url: selectedPort ? `http://127.0.0.1:${selectedPort}` : undefined,
      db, log, root, ...completed, result: completed ? "passed" : "failed", cleaned: true }) + "\n")
  }
}, 100_000)

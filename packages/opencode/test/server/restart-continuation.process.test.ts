// Private runtime regression for system-handled daemon restart continuation.
//
// Drives the real oc-server recovery worker against a real `opencode serve` child that a fake
// launchd hard-kills and relaunches on the same explicit private port and private DB. Every
// launch proves URL, PID, listener and DB identity before the worker may send a request.
// Opt-in: OPENCODE_RESTART_RECOVERY=/abs/path/to/oc-server-recovery.py bun test <this file>
import { expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { testProviderConfig } from "../lib/test-provider"
import { restartMarkers } from "../../../es-app/src/restart-marker"
import type { Message } from "@opencode-ai/sdk/v2"

const recovery = process.env.OPENCODE_RESTART_RECOVERY
const entry = path.resolve(import.meta.dir, "../../src/index.ts")

if (!recovery) test.skip("restart continuation runtime harness (set OPENCODE_RESTART_RECOVERY)", () => {})
else
  test(
    "controlled restarts continue a busy session as system provenance, twice, and leave a session cut inside a tool uncertain",
    async () => {
      expect(path.isAbsolute(recovery)).toBe(true)
      // Outside every repository: project config discovery walks upward and must not find a real `.opencode`.
      const root = await realpath(await mkdtemp(path.join("/private/tmp", "opencode-restart-harness-")))
      const home = path.join(root, "home")
      const project = path.join(root, "project")
      const restarts = path.join(root, "restarts")
      const db = path.join(root, "runtime.sqlite3")
      const pidFile = path.join(root, "daemon.pid")
      const gates = [path.join(root, "gate-1"), path.join(root, "gate-2"), path.join(root, "gate-unsafe")]
      const counter = path.join(project, "tool-runs")
      await Promise.all([mkdir(home, { recursive: true }), mkdir(project, { recursive: true }), mkdir(path.join(root, "tmp"))])
      expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0)

      // Fake provider: the main session runs one tool, then holds its next two provider requests open
      // until the daemon is killed under them; the unsafe session is killed inside a running tool.
      // Every request body is kept, so a repeated or fabricated turn is visible in the assertions.
      const requests: Record<string, any>[] = []
      const unsafeRuns = path.join(project, "unsafe-runs")
      const turns = { main: 0, unsafe: 0 }
      const provider = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || "{}")
        requests.push(body)
        const kind = JSON.stringify(body.messages ?? []).includes("unsafe work") ? "unsafe" : "main"
        if (body.tools) turns[kind]++
        const turn = turns[kind]
        const held = kind === "main" && (turn === 2 || turn === 3) ? gates[turn - 2]! : undefined
        if (held) {
          let open = true
          req.on("close", () => (open = false))
          res.on("close", () => (open = false))
          while (open) await Bun.sleep(50)
          return
        }
        const step = !body.tools
          ? { text: "Restart harness" }
          : kind === "unsafe"
            ? turn === 1
              ? { tool: `printf y >> '${unsafeRuns}'; while test ! -f '${gates[2]}'; do sleep 0.1; done` }
              : { text: "unsafe-should-not-continue" }
            : turn === 1
              ? { tool: `printf x >> '${counter}' && printf ran-once` }
              : { text: "resumed-done" }
        res.writeHead(200, { "content-type": "text/event-stream" })
        const chunk = (delta: unknown, finish: string | null) =>
          res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
        if ("text" in step) {
          chunk({ role: "assistant", content: step.text }, null)
          chunk({}, "stop")
        } else {
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${kind}_${turn}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: step.tool, description: "harness step", timeout: 600000 }) } }] }, null)
          chunk({}, "tool_calls")
        }
        res.end("data: [DONE]\n\n")
      })
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
      const providerAddress = provider.address()
      if (!providerAddress || typeof providerAddress === "string") throw new Error("provider must be loopback TCP")
      await writeFile(
        path.join(project, "opencode.json"),
        JSON.stringify({
          ...testProviderConfig(`http://127.0.0.1:${providerAddress.port}/v1`),
          plugin: [],
          permission: { bash: "allow" },
          small_model: "test/test-model",
        }),
      )

      // An explicit, verified-free, nonproduction port; a bind race fails the launch, never falls back.
      const reservation = createServer()
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
      const reserved = reservation.address()
      if (!reserved || typeof reserved === "string" || reserved.port <= 0 || reserved.port === 4096) throw new Error("no private port")
      const port = reserved.port
      await new Promise<void>((resolve) => reservation.close(() => resolve()))
      const url = `http://127.0.0.1:${port}`

      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_DB: db,
        OPENCODE_DISABLE_SHARE: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_CONFIG: path.join(project, "opencode.json"),
        // The machine's managed config would replace the fake provider; tests isolate it the same way preload does.
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      }

      // Fake launchd. `kickstart -k` hard-kills the owned daemon (SIGKILL: no graceful cleanup, as the
      // production kickstart left orphaned rows) and relaunches it; the new PID is published only
      // after its listener and DB identity are proven, so the worker cannot reach an impostor.
      const launcher = path.join(root, "launchctl")
      await writeFile(
        launcher,
        `#!/usr/bin/env python3
import os, signal, subprocess, sys, time
PID, PORT, DB, LOG = ${JSON.stringify(pidFile)}, ${port}, ${JSON.stringify(db)}, ${JSON.stringify(path.join(root, "daemon.log"))}
def lsof(*args):
    return subprocess.run(["/usr/sbin/lsof", "-nP", *args], capture_output=True, text=True).stdout
def launch():
    out = open(LOG, "a")
    child = subprocess.Popen([${JSON.stringify(process.execPath)}, ${JSON.stringify(entry)}, "serve", "--hostname", "127.0.0.1", "--port", str(PORT)],
        cwd=${JSON.stringify(project)}, stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True)
    for _ in range(600):
        if child.poll() is not None: sys.exit(f"daemon exited {child.returncode}")
        listening = f"p{child.pid}\\n" in lsof("-a", "-p", str(child.pid), "-iTCP:%d" % PORT, "-sTCP:LISTEN", "-Fpn") and f"n127.0.0.1:{PORT}\\n" in lsof("-a", "-p", str(child.pid), "-iTCP:%d" % PORT, "-sTCP:LISTEN", "-Fpn")
        owners = set(lsof("-iTCP:%d" % PORT, "-sTCP:LISTEN", "-t").split())
        if listening and owners == {str(child.pid)} and f"n{DB}\\n" in lsof("-a", "-p", str(child.pid), "-Fn"):
            open(PID + ".tmp", "w").write(str(child.pid)); os.replace(PID + ".tmp", PID)
            open(PID + ".history", "a").write(f"{child.pid}\\n")
            return
        time.sleep(0.1)
    child.kill(); sys.exit("daemon identity not proven")
match sys.argv[1:]:
    case ["print", _]:
        print("pid = " + open(PID).read().strip())
    case ["kickstart", "-k", _]:
        old = int(open(PID).read())
        os.kill(old, signal.SIGKILL)
        while subprocess.run(["/bin/kill", "-0", str(old)], capture_output=True).returncode == 0: time.sleep(0.05)
        while lsof("-iTCP:%d" % PORT, "-sTCP:LISTEN", "-t").strip(): time.sleep(0.05)
        launch()
    case ["start"]:
        launch()
    case _:
        sys.exit(f"unexpected launchctl {sys.argv[1:]}")
`,
        { mode: 0o755 },
      )

      const run = (args: string[], timeout = 120_000) => {
        const result = Bun.spawnSync([recovery, ...args], {
          env: { ...env, PATH: env.PATH, OPENCODE_URL: url, OPENCODE_DB: db, OC_RESTART_DIR: restarts, OC_LAUNCHCTL: launcher, OC_RESTART_WAIT_SECONDS: "120" },
          timeout,
        })
        return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
      }
      const api = async (route: string, init: RequestInit = {}) => {
        const target = new URL(route, url)
        target.searchParams.set("directory", project)
        const response = await fetch(target, {
          ...init,
          headers: init.body ? { "content-type": "application/json" } : {},
          signal: AbortSignal.timeout(10_000),
        })
        return { status: response.status, body: response.status === 204 ? undefined : ((await response.json()) as any) }
      }
      const until = async <T>(label: string, probe: () => Promise<T | undefined>, ms = 90_000) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
          const value = await probe().catch(() => undefined)
          if (value !== undefined) return value
          await Bun.sleep(100)
        }
        throw new Error(`timed out: ${label}`)
      }
      const daemonPid = async () => Number((await readFile(pidFile, "utf8")).trim())
      const assertIdentity = async () => {
        const pid = await daemonPid()
        const listeners = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"]).stdout.toString().split(/\s+/).filter(Boolean)
        expect(listeners).toEqual([String(pid)])
        expect(Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-a", "-p", String(pid), "-Fn"]).stdout.toString()).toContain(`n${db}\n`)
        expect(Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString()).toContain(`${entry} serve --hostname 127.0.0.1 --port ${port}`)
        expect((await readFile(path.join(root, "daemon.log"), "utf8"))).toContain(`opencode server listening on ${url}`)
        return pid
      }
      const history = async (session: string) => (await api(`/session/${session}/message`)).body as { info: Message; parts: any[] }[]
      const busy = async (session: string) => (await api("/session/status")).body?.[session]?.type === "busy"
      const heldAt = (session: string, turn: number) =>
        until(`main provider turn ${turn} held`, async () => (turns.main >= turn && (await busy(session)) ? true : undefined))
      const runningTool = (session: string) =>
        until("unsafe tool running", async () => {
          if (!(await busy(session))) return undefined
          return (await history(session)).flatMap((m) => m.parts).some((p) => p.type === "tool" && p.state.status === "running") ? true : undefined
        })
      const restart = async () => {
        const started = run(["restart"])
        expect(started.code, started.stderr).toBe(0)
        const paths = JSON.parse(started.stdout)
        const result = await until("restart terminal phase", async () => {
          const value = JSON.parse(await readFile(paths.result, "utf8"))
          return ["revived", "revive-uncertain", "failed"].includes(value.phase) ? value : undefined
        }, 180_000)
        const journal = (await readFile(`${result.final_manifest}.journal`, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        return { result, journal, log: await readFile(paths.log, "utf8") }
      }

      const evidence: Record<string, unknown> = { root, url, db, port }
      try {
        expect(Bun.spawnSync([launcher, "start"], { env, timeout: 120_000 }).exitCode).toBe(0)
        const firstPid = await assertIdentity()
        evidence.pids = [firstPid]
        const identity = new Sqlite(db, { readonly: true })
        expect(identity.query("PRAGMA database_list").all()).toContainEqual(expect.objectContaining({ file: db }))
        identity.close()

        const prompt = async (title: string, text: string) => {
          const created = await api("/session", { method: "POST", body: JSON.stringify({ title }) })
          expect(created.status).toBe(200)
          const id = created.body.id as string
          const sent = await api(`/session/${id}/prompt_async`, {
            method: "POST",
            body: JSON.stringify({ agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text }] }),
          })
          expect(sent.status).toBe(204)
          return id
        }
        const session = await prompt("Restart harness", "do the work")
        const unsafe = await prompt("Unsafe harness", "unsafe work")
        await heldAt(session, 2)
        await runningTool(unsafe)
        expect(await readFile(counter, "utf8")).toBe("x")
        expect(await readFile(unsafeRuns, "utf8")).toBe("y")

        // Restart 1: main is waiting on the provider, unsafe is inside a tool.
        const one = await restart()
        evidence.first = one
        expect(one.result.phase).toBe("revive-uncertain")
        expect(one.journal.map((entry) => [entry.id, entry.state, entry.mode]).toSorted()).toEqual(
          [
            [session, "attempting", "native"],
            [session, "accepted", "native"],
            [unsafe, "attempting", "native"],
            [unsafe, "unsafe", "native"],
          ].toSorted(),
        )
        const secondPid = await assertIdentity()
        expect(secondPid).not.toBe(firstPid)
        expect(one.result.new_pid).toBe(secondPid)
        // The unsafe outcome holds further restarts until a human inspects it; clearing sends nothing.
        expect(run(["restart"]).code).not.toBe(0)
        const cleared = run(["clear", one.result.final_manifest])
        expect(cleared.code, cleared.stderr).toBe(0)

        // The continuation is itself interrupted by restart 2 while its provider request is open.
        await heldAt(session, 3)
        const two = await restart()
        evidence.second = two
        expect(two.result.phase).toBe("revived")
        expect(two.journal.map((entry) => [entry.id, entry.state])).toEqual([
          [session, "attempting"],
          [session, "accepted"],
        ])
        const thirdPid = await assertIdentity()
        expect(thirdPid).not.toBe(secondPid)
        evidence.pids = [firstPid, secondPid, thirdPid]

        const final = await until("resumed turn finished", async () => {
          if (await busy(session)) return undefined
          const messages = await history(session)
          const last = messages.at(-1)
          return last?.info.role === "assistant" && last.parts.some((p) => p.type === "text" && p.text === "resumed-done") ? messages : undefined
        })
        const unsafeFinal = await history(unsafe)
        const summary = (messages: typeof final) =>
          messages.map((m) => ({ id: m.info.id, role: m.info.role, restarts: m.info.restarts, parts: m.parts.map((p) => (p.type === "tool" ? `${p.tool}:${p.state.status}` : p.type)) }))
        evidence.messages = summary(final)
        evidence.unsafeMessages = summary(unsafeFinal)

        // No human or peer prompt was fabricated in either session.
        expect(final.filter((m) => m.info.role === "user").map((m) => m.parts.map((p) => p.text).join(""))).toEqual(["do the work"])
        expect(unsafeFinal.filter((m) => m.info.role === "user")).toHaveLength(1)
        expect(JSON.stringify([final, unsafeFinal])).not.toContain("continue (the opencode daemon")
        // Each tool ran exactly once across both restarts; the unsafe one is still shown as running.
        expect(await readFile(counter, "utf8")).toBe("x")
        expect(await readFile(unsafeRuns, "utf8")).toBe("y")
        expect(unsafeFinal.flatMap((m) => m.parts).filter((p) => p.type === "tool").map((p) => p.state.status)).toEqual(["running"])
        const markers = final.flatMap((m) => (m.info.restarts ?? []).map((marker) => ({ anchor: m.info.id, marker })))
        expect(markers.map((item) => [item.marker.restartID, item.marker.outcome, item.marker.interruptedTools])).toEqual([
          [path.basename(one.result.final_manifest, ".json"), "scheduled", 0],
          [path.basename(two.result.final_manifest, ".json"), "scheduled", 0],
        ])
        const unsafeMarkers = unsafeFinal.flatMap((m) => m.info.restarts ?? [])
        expect(unsafeMarkers.map((marker) => [marker.restartID, marker.outcome, marker.reason, marker.interruptedTools])).toEqual([
          [path.basename(one.result.final_manifest, ".json"), "uncertain", "interrupted-tool", 1],
        ])
        // Provider turns: main 1 tool + 2 held + 1 final; unsafe only its original tool call.
        expect(turns).toEqual({ main: 4, unsafe: 1 })
        const mainTurns = requests.filter((body) => body.tools && !JSON.stringify(body.messages).includes("unsafe work"))
        expect(mainTurns.map((body) => JSON.stringify(body.messages).split("do the work").length - 1)).toEqual([1, 1, 1, 1])
        expect(mainTurns.slice(1).every((body) => JSON.stringify(body.messages).includes("ran-once"))).toBe(true)
        expect(requests.every((body) => !/restart-\d{13}-/.test(JSON.stringify(body)))).toBe(true)

        // UI marker states from real records.
        const infos = final.map((m) => m.info)
        expect(markers.flatMap((item) => restartMarkers(infos.find((m) => m.id === item.anchor)!, infos, false).map((view) => view.state))).toEqual(["resumed", "resumed"])
        const unsafeInfos = unsafeFinal.map((m) => m.info)
        expect(unsafeInfos.flatMap((info) => restartMarkers(info, unsafeInfos, false).map((view) => view.state))).toEqual(["uncertain"])

        // Lost acknowledgment and repeated revival reconcile without a second continuation.
        const manifest = two.result.final_manifest
        const restartID = path.basename(manifest, ".json")
        const anchor = markers[1]!.anchor
        const again = await api(`/session/${session}/restart`, {
          method: "POST",
          body: JSON.stringify({ restartID, anchorMessageID: anchor, capturedAt: 0 }),
        })
        expect(again.body).toEqual({ outcome: "duplicate", marker: markers[1]!.marker })
        expect((await api(`/session/${session}/restart?restartID=${restartID}&anchorMessageID=${anchor}`)).body).toEqual({ marker: markers[1]!.marker, later: true })
        const rerun = run(["revive", manifest])
        expect(rerun.code, rerun.stderr).toBe(0)
        expect(rerun.stdout).toContain(`already recorded ${session}`)
        const rerunUnsafe = run(["revive", one.result.final_manifest])
        expect(rerunUnsafe.code).not.toBe(0)
        expect(turns).toEqual({ main: 4, unsafe: 1 })
        expect((await history(session)).filter((m) => m.info.role === "user")).toHaveLength(1)
        evidence.result = "pass"
      } finally {
        await Promise.all(gates.map((gate) => writeFile(gate, "")))
        const pids = (await readFile(`${pidFile}.history`, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number)
        for (const pid of pids) {
          try { process.kill(-pid, "SIGTERM") } catch {}
        }
        await Bun.sleep(1_000)
        for (const pid of pids) {
          try { process.kill(-pid, "SIGKILL") } catch {}
        }
        const leftover = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"]).stdout.toString().trim()
        evidence.listenerAfterCleanup = leftover
        provider.close()
        await writeFile(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2))
        console.log(`restart harness evidence: ${path.join(root, "evidence.json")}`)
        expect(leftover).toBe("")
      }
    },
    600_000,
  )

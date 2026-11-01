import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createBridge } from "./bridge"
import { serve } from "./server"
import { createSshPeer, sshArgs, type SshHost } from "./ssh-peer"
import { remoteHosts } from "../../es-app/remote-host"

// Pinned-SSH read adapter for a Personal host (contract work-hosts-and-pins §5b), against a fake `ssh` on PATH.
const FAKE_SSH = path.join(import.meta.dir, "../test/fixtures/fake-ssh")
const YGNIUM: SshHost = { id: "ygnium", destination: "murtaza@ygnium.lan", corePort: 4096, dashboardPort: 7777 }

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const scratch = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "es-ssh-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const fakeSsh = async (mode = "ok") => {
  const dir = await scratch()
  await chmod(path.join(FAKE_SSH, "ssh"), 0o755)
  const logFile = path.join(dir, "ssh.log")
  await writeFile(logFile, "")
  return {
    env: { ...process.env, PATH: `${FAKE_SSH}:${process.env.PATH}`, FAKE_SSH_MODE: mode, FAKE_SSH_LOG: logFile, FAKE_SSH_CORE_PORT: "4096", FAKE_SSH_DASHBOARD_PORT: "7777" },
    log: async () => (await readFile(logFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    dir,
  }
}

const peer = async (mode = "ok", backoff = { initial: 50, max: 200 }) => {
  const ssh = await fakeSsh(mode)
  const created = createSshPeer({ host: YGNIUM, dir: path.join(ssh.dir, "ssh"), env: ssh.env, backoff })
  cleanup.push(() => created.stop())
  return { ...ssh, peer: created }
}

// The bridged Personal listener (excalibur over its gateway) with ygnium as its SSH peer.
const personalListener = async (sshPeer: ReturnType<typeof createSshPeer>) => {
  const root = await scratch()
  await writeFile(path.join(root, "index.html"), "<title>Personal</title>")
  const excalibur = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Response.json({ host: "excalibur", path: new URL(request.url).pathname }) })
  cleanup.push(async () => void (await excalibur.stop(true)))
  const bridge = createBridge({ origin: excalibur.url.origin, store: { access: async () => ({ clientId: "id", clientSecret: "secret" }), cookie: async () => "fixture-pairing-cookie-0123456789", saveCookie: async () => undefined } })
  await bridge.ready
  const server = await serve({ root, remote: { id: "excalibur", origin: excalibur.url.origin, bridge }, sshPeers: [{ id: "ygnium", peer: sshPeer }] })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  return (pathname: string, init: RequestInit = {}) => fetch(`${server.origin}${pathname}`, { redirect: "manual", ...init, headers: { "x-editspace-key": server.key, ...init.headers } })
}

test("the ssh child gets exactly the pinned forwards: no SOCKS, batch mode, strict pinned host key", async () => {
  expect(sshArgs(YGNIUM, "/data/ssh/ygnium")).toEqual([
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "HostKeyAlias=ygnium",
    "-o", "ExitOnForwardFailure=yes",
    "-N",
    "-L", "/data/ssh/ygnium/core.sock:127.0.0.1:4096",
    "-L", "/data/ssh/ygnium/dash.sock:127.0.0.1:7777",
    "murtaza@ygnium.lan",
  ])
  const { peer: started, log, dir } = await peer()
  await started.start()
  expect(started.reach()).toEqual({ state: "ready" })
  const [first] = await log()
  expect(first!.argv).toEqual(sshArgs(YGNIUM, path.join(dir, "ssh", "ygnium")))
  expect(((await stat(path.join(dir, "ssh", "ygnium"))).mode & 0o777).toString(8)).toBe("700")
})

test("an allowlisted read reaches ygnium's Core and pins with rebuilt headers and no cookies back", async () => {
  const { peer: started, log } = await peer()
  await started.start()
  const get = await personalListener(started)
  const session = await get("/hosts/ygnium/oc/session/ses_shared?directory=%2Fwork", {
    headers: { cookie: "es_remote=x; es_attention_operator=y", authorization: "Bearer z", "cf-access-client-id": "leak", accept: "application/json" },
  })
  expect(session.status).toBe(200)
  expect(await session.json()).toEqual({ host: "ygnium", socket: "core", path: "/session/ses_shared" })
  expect(session.headers.get("set-cookie")).toBeNull()
  const pins = await get("/hosts/ygnium/es/api/pins")
  expect((await pins.json()).profile).toBe("personal")
  const reads = (await log()).filter((entry) => entry.socket)
  const sessionRead = reads.find((entry) => entry.path === "/session/ses_shared?directory=%2Fwork")!
  const sent = Object.keys(sessionRead.headers as object)
  expect(sent).toContain("accept")
  expect(sent.filter((name) => ["cookie", "authorization", "origin", "referer", "x-editspace-key"].includes(name) || name.startsWith("cf-"))).toEqual([])
  // Colliding session ids stay distinct: the same id on the listener's own host is excalibur's.
  expect(await (await get("/oc/session/ses_shared")).json()).toEqual({ host: "excalibur", path: "/oc/session/ses_shared" })
})

test("writes and unlisted routes are refused with zero bytes on the sockets", async () => {
  const { peer: started, log } = await peer()
  await started.start()
  const get = await personalListener(started)
  const before = (await log()).filter((entry) => entry.socket).length
  const refused = [
    await get("/hosts/ygnium/es/api/pins/session:ses_1", { method: "PUT", headers: { "content-type": "application/json", origin: "http://x" }, body: "{}" }),
    await get("/hosts/ygnium/oc/session/ses_1/prompt_async", { method: "POST", body: "{}" }),
    await get("/hosts/ygnium/es/api/editspaces"),
    await get("/hosts/ygnium/es/api/attention"),
    await get("/hosts/ygnium/oc/file/content"),
  ]
  expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403, 403])
  expect((await log()).filter((entry) => entry.socket).length).toBe(before)
})

test("an upstream redirect is never followed", async () => {
  const { peer: started } = await peer()
  await started.start()
  const get = await personalListener(started)
  expect((await get("/hosts/ygnium/oc/session/redirect")).status).toBe(502)
})

test("a host-key mismatch is auth, with no reads and no retry until the config changes", async () => {
  const { peer: started, log } = await peer("hostkey")
  await started.start()
  expect(started.reach()).toEqual({ state: "unreachable", reason: "auth" })
  await Bun.sleep(300)
  expect((await log()).filter((entry) => entry.argv).length).toBe(1)
  const get = await personalListener(started)
  const response = await get("/hosts/ygnium/oc/experimental/session")
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: "Host unreachable", reason: "auth" })
})

test("an unreachable host is network and retries with doubling backoff, not a storm", async () => {
  const { peer: started, log } = await peer("refused", { initial: 100, max: 400 })
  await started.start()
  expect(started.reach()).toEqual({ state: "unreachable", reason: "network" })
  const attempts = async () => (await log()).filter((entry) => entry.argv).map((entry) => entry.at as number)
  for (let wait = 50; (await attempts()).length < 3 && wait < 5_000; wait *= 2) await Bun.sleep(wait)
  const [first, second, third] = await attempts()
  expect(second! - first!).toBeGreaterThanOrEqual(100)
  expect(third! - second!).toBeGreaterThanOrEqual(200)
})

test("a dashboard reporting another profile is refused as profile, with no Core reads", async () => {
  const { peer: started, log } = await peer("work")
  await started.start()
  expect(started.reach()).toEqual({ state: "unreachable", reason: "profile" })
  const get = await personalListener(started)
  const response = await get("/hosts/ygnium/oc/experimental/session")
  expect(await response.json()).toEqual({ error: "Host unreachable", reason: "profile" })
  expect((await log()).filter((entry) => entry.socket === "core")).toEqual([])
})

test("stop ends the ssh child and removes its sockets", async () => {
  const { peer: started, dir } = await peer()
  await started.start()
  await started.stop()
  expect(started.reach()).toEqual({ state: "stopped" })
  expect(await stat(path.join(dir, "ssh", "ygnium", "core.sock")).catch(() => undefined)).toBeUndefined()
})

test("only a bridged listener takes SSH peers", async () => {
  const { peer: started } = await peer()
  const root = await scratch()
  await writeFile(path.join(root, "index.html"), "<title>Work</title>")
  await expect(serve({ root, opencode: "http://127.0.0.1:4096", dashboard: "http://127.0.0.1:7777", sshPeers: [{ id: "ygnium", peer: started }] })).rejects.toThrow()
})

test("the first read through the listener starts the ssh child", async () => {
  const { peer: idle, log } = await peer()
  expect(idle.reach()).toEqual({ state: "stopped" })
  const get = await personalListener(idle)
  const response = await get("/hosts/ygnium/oc/experimental/session")
  expect(response.status).toBe(200)
  expect(idle.reach()).toEqual({ state: "ready" })
  expect((await log()).filter((entry) => entry.argv).length).toBe(1)
})

test("ssh hosts are configured as pinned Personal targets only", () => {
  const ygnium = { id: "ygnium", label: "Ygnium", mode: "ssh", ssh: { destination: "murtaza@ygnium.lan", corePort: 4096, dashboardPort: 7777 } }
  expect(remoteHosts([ygnium])).toEqual([
    { id: "ygnium", label: "Ygnium", origin: "ssh://ygnium", mode: "ssh", profile: "personal", ssh: { destination: "murtaza@ygnium.lan", corePort: 4096, dashboardPort: 7777 } },
  ])
  expect(() => remoteHosts([{ ...ygnium, profile: "work" }])).toThrow("Personal only")
  expect(() => remoteHosts([{ ...ygnium, ssh: undefined }])).toThrow("ssh.destination")
  for (const destination of ["-oProxyCommand=x", "a b", "u@h:22", "u@h/x", ""])
    expect(() => remoteHosts([{ ...ygnium, ssh: { ...ygnium.ssh, destination } }])).toThrow("ssh.destination")
  expect(() => remoteHosts([{ ...ygnium, ssh: { ...ygnium.ssh, corePort: 0 } }])).toThrow("corePort")
  expect(() => remoteHosts([{ ...ygnium, ssh: { ...ygnium.ssh, dashboardPort: "7777" } }])).toThrow("dashboardPort")
})

test("stop during a start in flight leaves no ssh child behind", async () => {
  const { peer: started, dir } = await peer()
  const starting = started.start()
  await started.stop()
  await starting
  await Bun.sleep(300)
  expect(started.reach()).toEqual({ state: "stopped" })
  // Every fake ssh child carries its socket paths (under this test's private dir) in its argv.
  expect(spawnSync("pgrep", ["-f", path.join(dir, "ssh")], { encoding: "utf8" }).stdout.trim()).toBe("")
})

test("an existing socket directory is tightened to owner-only", async () => {
  const { peer: started, dir } = await peer()
  const { mkdir } = await import("node:fs/promises")
  await mkdir(path.join(dir, "ssh", "ygnium"), { recursive: true, mode: 0o755 })
  await chmod(path.join(dir, "ssh", "ygnium"), 0o755)
  await started.start()
  expect(((await stat(path.join(dir, "ssh", "ygnium"))).mode & 0o777).toString(8)).toBe("700")
})

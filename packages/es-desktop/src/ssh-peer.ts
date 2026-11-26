/* A Personal host read over pinned SSH (contract work-hosts-and-pins §5b, PROPOSED; fixtures only, no live use).
 * One `ssh` child per host forwards two unix sockets in a private directory to that host's loopback Core and dashboard.
 * Forwarded requests arrive there as loopback, which the host treats as local trust, so this adapter (with the
 * listener's allowlist in server.ts) is what keeps them read-only. Destination, ports and host key alias come from
 * desktop config only; nothing a page sends chooses a host, port or path. */
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, rm, stat } from "node:fs/promises"
import { request } from "node:http"
import path from "node:path"

export type SshHost = { id: string; destination: string; corePort: number; dashboardPort: number }
export type Reach = { state: "starting" | "ready" | "stopped" } | { state: "unreachable"; reason: "network" | "auth" | "profile" }

export const sshArgs = (host: SshHost, dir: string) => [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", `HostKeyAlias=${host.id}`,
  "-o", "ExitOnForwardFailure=yes",
  "-N",
  "-L", `${path.join(dir, "core.sock")}:127.0.0.1:${host.corePort}`,
  "-L", `${path.join(dir, "dash.sock")}:127.0.0.1:${host.dashboardPort}`,
  host.destination,
]

// ssh's own words for a host key it cannot accept; anything else that ends the child is the network.
const HOST_KEY = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (?:\S+ )?host key is known/

export const createSshPeer = (options: { host: SshHost; dir: string; env?: NodeJS.ProcessEnv; backoff?: { initial: number; max: number } }) => {
  const dir = path.join(options.dir, options.host.id)
  const sockets = { core: path.join(dir, "core.sock"), dashboard: path.join(dir, "dash.sock") }
  const backoff = options.backoff ?? { initial: 1_000, max: 60_000 }
  // `generation` changes on every stop(), so an attempt that was in flight when the peer stopped never spawns or keeps
  // a child afterwards.
  const state: { reach: Reach; child?: ChildProcess; timer?: ReturnType<typeof setTimeout>; delay: number; running?: Promise<void>; generation: number } = {
    reach: { state: "stopped" },
    delay: backoff.initial,
    generation: 0,
  }

  const attempt = async () => {
    const generation = state.generation
    state.reach = { state: "starting" }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // mkdir leaves an existing directory's mode alone.
    await chmod(dir, 0o700)
    // ssh refuses to bind over a stale socket from an earlier child.
    await Promise.all(Object.values(sockets).map((socket) => rm(socket, { force: true })))
    if (state.generation !== generation) return
    const child = spawn("ssh", sshArgs(options.host, dir), { env: options.env ?? process.env, stdio: ["ignore", "ignore", "pipe"] })
    state.child = child
    const stderr: string[] = []
    child.stderr?.on("data", (chunk: Buffer) => void stderr.push(chunk.toString("utf8")))
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.once("error", () => undefined)
    const up = await Promise.race([forwarded(), exited.then(() => false)])
    if (state.child !== child) return void child.kill()
    if (!up) {
      child.kill()
      return failed(HOST_KEY.test(stderr.join("")) ? "auth" : "network")
    }
    const profile = await selfReport()
    if (state.child !== child) return void child.kill()
    if (profile !== "personal") {
      child.kill()
      state.child = undefined
      // A host answering as another profile is a config error: no reads and no retry until the config changes.
      state.reach = { state: "unreachable", reason: "profile" }
      return
    }
    state.delay = backoff.initial
    state.reach = { state: "ready" }
    void exited.then(() => {
      if (state.child === child) failed(HOST_KEY.test(stderr.join("")) ? "auth" : "network")
    })
  }

  const failed = (reason: "network" | "auth") => {
    state.child = undefined
    state.reach = { state: "unreachable", reason }
    // A host key ssh will not accept stays refused until the config changes; the network is retried with backoff.
    if (reason === "auth") return
    state.timer = setTimeout(() => void attempt(), state.delay)
    state.delay = Math.min(state.delay * 2, backoff.max)
  }

  // Both sockets exist once ssh has authenticated and bound its forwards.
  const forwarded = async () => {
    for (let wait = 10; wait < 10_000; wait = Math.min(wait * 2, 500)) {
      const ready = await Promise.all(Object.values(sockets).map((socket) => stat(socket).then((info) => info.isSocket(), () => false)))
      if (ready.every(Boolean)) return true
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    return false
  }

  // The host's dashboard reports its profile in the pins listing (until it serves /__es/host); only Personal is read.
  const selfReport = () =>
    new Promise<string | undefined>((resolve) => {
      const call = request({ socketPath: sockets.dashboard, path: "/api/pins", method: "GET", headers: { host: "127.0.0.1", accept: "application/json" }, timeout: 10_000 }, (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          const body = (() => { try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown } catch { return undefined } })()
          resolve(response.statusCode === 200 && body && typeof body === "object" ? String((body as Record<string, unknown>).profile) : undefined)
        })
      })
      call.on("timeout", () => call.destroy())
      call.on("error", () => resolve(undefined))
      call.end()
    })

  return {
    sockets,
    reach: () => state.reach,
    /** Starts the child (if stopped) and resolves once it is ready or has failed its first attempt. */
    start: () => {
      if (state.reach.state === "stopped") state.running = attempt()
      return state.running ?? Promise.resolve()
    },
    stop: async () => {
      state.generation++
      clearTimeout(state.timer)
      const child = state.child
      state.child = undefined
      state.reach = { state: "stopped" }
      if (child && child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve))
        child.kill()
        await exited
      }
      // An attempt in flight sees the new generation and ends its own child; wait for it before removing sockets.
      await state.running?.catch(() => undefined)
      await Promise.all(Object.values(sockets).map((socket) => rm(socket, { force: true })))
    },
  }
}

export type SshPeer = ReturnType<typeof createSshPeer>

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { applyListing, createPinsClient, migrationOps, orderedPins, pinPath, pinUnionKey, syncableHost } from "./pins-sync"

const DOTFILES_BIN = process.env.DOTFILES_BIN ?? path.join(homedir(), "dotfiles/bin")
const hasStore = existsSync(path.join(DOTFILES_BIN, "es_pins.py"))
const cleanup: (() => Promise<unknown>)[] = []
afterAll(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// One host running the real dashboard pin store behind the real attention guard, in its own temporary HOME.
const storeHost = async (profile = "work") => {
  const home = await mkdtemp(path.join(tmpdir(), "es-pins-host-"))
  const child = Bun.spawn(["uv", "run", "--script", path.join(import.meta.dir, "fixtures/pins-host.py")], {
    env: { ...process.env, HOME: home, DOTFILES_BIN, ES_DASHBOARD_PROFILE: profile, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(homedir(), ".cache/uv") },
    stdout: "pipe",
    stderr: "inherit",
  })
  cleanup.push(async () => {
    child.kill()
    await child.exited
    await rm(home, { recursive: true, force: true })
  })
  const reader = child.stdout.getReader()
  const port = new TextDecoder().decode((await reader.read()).value).trim()
  reader.releaseLock()
  const origin = `http://127.0.0.1:${port}`
  for (let wait = 50; ; wait *= 2) {
    const ready = await fetch(`${origin}/api/pins`).then((response) => response.ok, () => false)
    if (ready) break
    await Bun.sleep(wait)
  }
  return origin
}

// A browser tab of that host through its listener: the listener presents the dashboard its own origin, the tab
// keeps its own cookies. `down` makes the host unreachable from this tab.
const tab = (origin: string) => {
  const jar = new Map<string, string>()
  const state = { down: false }
  const send = async (input: string, init?: RequestInit) => {
    if (state.down) throw new TypeError("fetch failed")
    const url = String(input).replace(/^\/es\/api\//, `${origin}/api/`)
    const headers = new Headers(init?.headers)
    headers.set("origin", origin)
    if (jar.size) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "))
    const response = await fetch(url, { ...init, headers })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";")
      const [name, value] = pair!.split("=")
      jar.set(name!, value!)
    }
    return response
  }
  return Object.assign(send, { state })
}

const memoryStorage = () => {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() { return items.size },
  } satisfies Storage
}

const client = (host: string, send: (input: string, init?: RequestInit) => Promise<Response>, storage = memoryStorage(), profile = "work") =>
  createPinsClient({ host, prefix: "", profile, fetch: send, storage })

describe("pin refs and views", () => {
  test("a lane ref is one path segment with its slash encoded once", () => {
    expect(pinPath("lane:opencode/orchestrator")).toBe("/es/api/pins/lane:opencode%2Forchestrator")
    expect(pinPath("session:ses_a")).toBe("/es/api/pins/session:ses_a")
  })

  test("the same ref on two hosts is two pins", () => {
    expect(pinUnionKey("mini", "lane:opencode/x")).not.toBe(pinUnionKey("laptop", "lane:opencode/x"))
  })

  test("only a verified host id syncs: never the local alias, an origin or a port", () => {
    expect([syncableHost("mini"), syncableHost("laptop")]).toEqual([true, true])
    expect([syncableHost("local"), syncableHost(undefined), syncableHost("127.0.0.1:60302"), syncableHost("Mini")]).toEqual([false, false, false, false])
    expect(() => createPinsClient({ host: "local", prefix: "", profile: "work", storage: memoryStorage() })).toThrow()
  })

  test("a change listing replaces changed pins and removes tombstoned ones; a reset replaces all", () => {
    const pins = [{ ref: "session:a", pinnedAt: 1 }, { ref: "session:b", pinnedAt: 2 }]
    expect(applyListing(pins, { pins: [{ ref: "session:c", pinnedAt: 3 }], tombstones: [{ ref: "session:a", at: 4 }] }).map((pin) => pin.ref)).toEqual(["session:b", "session:c"])
    expect(applyListing(pins, { reset: true, pins: [{ ref: "session:z", pinnedAt: 9 }], tombstones: [] }).map((pin) => pin.ref)).toEqual(["session:z"])
  })

  test("explicit order comes first, then the most recently pinned", () => {
    expect(orderedPins([{ ref: "a", pinnedAt: 1 }, { ref: "b", pinnedAt: 5 }, { ref: "c", pinnedAt: 2, order: 1 }]).map((pin) => pin.ref)).toEqual(["c", "b", "a"])
  })

  test("a repeated import of the same local pin is the same op", () => {
    const first = migrationOps("mini", [{ ref: "lane:opencode/x", pinnedAt: 7 }, { ref: "lane:opencode/x", pinnedAt: 7 }, { ref: "bad ref" }])
    expect(first).toHaveLength(1)
    expect(first[0]!.body).toMatchObject({ at: 7, migrate: true })
    expect(migrationOps("mini", [{ ref: "lane:opencode/x", pinnedAt: 7 }])[0]!.body.op).toBe(first[0]!.body.op)
    expect(migrationOps("laptop", [{ ref: "lane:opencode/x", pinnedAt: 7 }])[0]!.body.op).not.toBe(first[0]!.body.op)
  })
})

describe.skipIf(!hasStore)("pins against the real host store", () => {
  test("two clients of one host: pin, reorder and unpin made on one appear on the other", async () => {
    const origin = await storeHost()
    const desktop = client("mini", tab(origin))
    const phone = client("mini", tab(origin))
    await desktop.refresh()
    // The first write has no operator session yet: the client sets one up on that host and retries the same op.
    await desktop.pin("lane:opencode/orchestrator")
    await desktop.pin("session:ses_solo")
    expect(desktop.state()).toMatchObject({ status: "ready", pending: 0, notSynced: [] })
    await phone.refresh()
    expect(phone.state().pins.map((pin) => pin.ref).toSorted()).toEqual(["lane:opencode/orchestrator", "session:ses_solo"])
    await phone.reorder("session:ses_solo", 0)
    await phone.unpin("lane:opencode/orchestrator")
    await desktop.refresh()
    expect(desktop.state().pins.map((pin) => [pin.ref, pin.order])).toEqual([["session:ses_solo", 0]])
  }, 60_000)

  test("the same ref pinned on two hosts stays two pins; unpinning on one leaves the other", async () => {
    const [mini, laptop] = await Promise.all([storeHost(), storeHost()])
    const onMini = client("mini", tab(mini))
    const onLaptop = client("laptop", tab(laptop))
    await Promise.all([onMini.refresh(), onLaptop.refresh()])
    await onMini.pin("lane:opencode/orchestrator")
    await onLaptop.pin("lane:opencode/orchestrator")
    await onMini.unpin("lane:opencode/orchestrator")
    await Promise.all([onMini.refresh(), onLaptop.refresh()])
    expect(onMini.state().pins).toEqual([])
    expect(onLaptop.state().pins.map((pin) => pin.ref)).toEqual(["lane:opencode/orchestrator"])
  }, 60_000)

  test("a write while the host is unreachable waits in that host's outbox and replays to it after a reload", async () => {
    const origin = await storeHost()
    const storage = memoryStorage()
    const offline = tab(origin)
    offline.state.down = true
    const before = client("mini", offline, storage)
    await before.refresh()
    await before.pin("session:ses_later")
    expect(before.state()).toMatchObject({ status: "unavailable", reason: "network", pending: 1 })
    const after = client("mini", tab(origin), storage)
    expect(after.state().pending).toBe(1)
    await after.refresh()
    expect(after.state()).toMatchObject({ status: "ready", pending: 0 })
    expect(after.state().pins.map((pin) => pin.ref)).toEqual(["session:ses_later"])
  }, 60_000)

  test("a store of another profile is refused and shows no pins", async () => {
    const origin = await storeHost("personal")
    const work = client("mini", tab(origin))
    await work.refresh()
    expect(work.state()).toMatchObject({ status: "unavailable", reason: "profile", pins: [] })
  }, 60_000)

  test("importing local pins happens once per host and never overrides an unpin the store holds", async () => {
    const origin = await storeHost()
    const phone = client("mini", tab(origin))
    await phone.refresh()
    await phone.pin("session:ses_kept")
    await phone.unpin("session:ses_kept")
    const desktop = client("mini", tab(origin))
    await desktop.refresh()
    await desktop.migrate([{ ref: "session:ses_kept" }, { ref: "lane:opencode/orchestrator" }])
    await desktop.migrate([{ ref: "session:ses_other" }])
    await phone.refresh()
    expect(phone.state().pins.map((pin) => pin.ref)).toEqual(["lane:opencode/orchestrator"])
    expect(desktop.state().notSynced).toEqual([])
  }, 60_000)

  test("the store refuses a pin write without the CSRF header", async () => {
    const origin = await storeHost()
    const send = tab(origin)
    await send("/es/api/attention/session", { method: "POST", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" })
    const response = await send("/es/api/pins/session:ses_a", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"at":1,"op":"op-12345678"}' })
    expect(response.status).toBe(403)
  }, 60_000)
})

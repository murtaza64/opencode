import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { applyListing, createPinsClient, migrationOps, migrationOrderOps, moveRank, orderedPins, pinPath, pinUnionKey, syncableHost, unionPins } from "./pins-sync"

const DOTFILES_BIN = process.env.DOTFILES_BIN ?? path.join(homedir(), "dotfiles/bin")
const hasStore = existsSync(path.join(DOTFILES_BIN, "es_pins.py"))
// Import order needs a store with the order precondition (dotfiles es_pins.py, contract §3 v0.2.4).
const hasOrderIf = hasStore && readFileSync(path.join(DOTFILES_BIN, "es_pins.py"), "utf8").includes('"orderIf"')
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

const client = (host: string, send: (input: string, init?: RequestInit) => Promise<Response>, storage = memoryStorage(), profile = "work", now?: () => number) =>
  createPinsClient({ host, prefix: "", profile, fetch: send, storage, now })

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

  test("pins never moved list newest first; a moved pin keeps the place its order gives it", () => {
    expect(orderedPins([{ ref: "a", pinnedAt: 1 }, { ref: "b", pinnedAt: 5 }, { ref: "c", pinnedAt: 2, order: -3 }]).map((pin) => pin.ref)).toEqual(["b", "c", "a"])
  })

  test("pins of every host form one interleaved order", () => {
    const union = unionPins([
      { host: "mini", pins: [{ ref: "session:a", pinnedAt: 100 }, { ref: "session:c", pinnedAt: 300 }] },
      { host: "laptop", pins: [{ ref: "session:b", pinnedAt: 200 }, { ref: "session:a", pinnedAt: 50 }] },
    ])
    expect(union.map((pin) => pinUnionKey(pin.host, pin.ref))).toEqual(["mini|session:c", "laptop|session:b", "mini|session:a", "laptop|session:a"])
  })

  test("moving a pin between two pins of other hosts ranks it between them, and at either end past them", () => {
    const [c, b, a] = [{ ref: "session:c", pinnedAt: 300 }, { ref: "session:b", pinnedAt: 200 }, { ref: "session:a", pinnedAt: 100 }]
    const moved = { ...a, order: moveRank(c, b) }
    expect(orderedPins([c, b, moved]).map((pin) => pin.ref)).toEqual(["session:c", "session:a", "session:b"])
    expect(orderedPins([c, b, { ...a, order: moveRank(undefined, c) }]).map((pin) => pin.ref)).toEqual(["session:a", "session:c", "session:b"])
    expect(orderedPins([c, b, { ...a, order: moveRank(b, undefined) }]).map((pin) => pin.ref)).toEqual(["session:c", "session:b", "session:a"])
  })

  test("equal ranks on two hosts order the same way on every client", () => {
    const pins = [{ host: "mini", ref: "session:x", pinnedAt: 5, order: 1 }, { host: "laptop", ref: "session:x", pinnedAt: 5, order: 1 }]
    expect(orderedPins(pins).map((pin) => pin.host)).toEqual(orderedPins(pins.toReversed()).map((pin) => pin.host))
  })

  test("an import's order follows the device's list and is conditioned on that import's own pin", () => {
    const local = [{ ref: "lane:opencode/b" }, { ref: "session:ses_a", pinnedAt: 7 }, { ref: "lane:opencode/b" }, { ref: "bad ref" }]
    const orders = migrationOrderOps("mini", local, 1000)
    const imports = migrationOps("mini", local)
    expect(orders.map((item) => [item.ref, item.body.order])).toEqual([["lane:opencode/b", 1], ["session:ses_a", 2]])
    expect(orders.map((item) => item.body.if)).toEqual(imports.map((item) => ({ op: item.body.op, unordered: true })))
    expect(migrationOrderOps("mini", local, 2000).map((item) => item.body.op)).toEqual(orders.map((item) => item.body.op))
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

  test("a pin moved between two pins of another host keeps that interleaved place for a second client, after reload and offline", async () => {
    const [mini, laptop] = await Promise.all([storeHost(), storeHost()])
    const base = Date.now() - 60_000
    const clock = { at: base }
    const now = () => clock.at
    const miniStorage = memoryStorage()
    const offline = tab(mini)
    const onMini = client("mini", offline, miniStorage, "work", now)
    const onLaptop = client("laptop", tab(laptop), memoryStorage(), "work", now)
    await Promise.all([onMini.refresh(), onLaptop.refresh()])
    clock.at = base + 1000; await onMini.pin("session:a")
    clock.at = base + 2000; await onLaptop.pin("session:b")
    clock.at = base + 3000; await onMini.pin("session:c")
    const union = () => unionPins([{ host: "mini", pins: onMini.state().pins }, { host: "laptop", pins: onLaptop.state().pins }]).map((pin) => pinUnionKey(pin.host, pin.ref))
    expect(union()).toEqual(["mini|session:c", "laptop|session:b", "mini|session:a"])
    // Moved between the Laptop's pin and the Mini's older pin while the Mini is unreachable: queued for the Mini only, replayed after a reload.
    const [b, a] = [onLaptop.state().pins[0]!, onMini.state().pins.find((pin) => pin.ref === "session:a")!]
    offline.state.down = true
    clock.at = base + 4000
    await onMini.reorder("session:c", moveRank(b, a))
    expect(onMini.state().pending).toBe(1)
    const reloaded = client("mini", tab(mini), miniStorage, "work", now)
    await reloaded.refresh()
    expect(reloaded.state().pending).toBe(0)
    // A second client of both hosts reads the same one order.
    const phoneMini = client("mini", tab(mini))
    const phoneLaptop = client("laptop", tab(laptop))
    await Promise.all([phoneMini.refresh(), phoneLaptop.refresh()])
    expect(unionPins([{ host: "mini", pins: phoneMini.state().pins }, { host: "laptop", pins: phoneLaptop.state().pins }]).map((pin) => pinUnionKey(pin.host, pin.ref)))
      .toEqual(["laptop|session:b", "mini|session:c", "mini|session:a"])
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

  test.skipIf(!hasOrderIf)("imported pins keep this device's order after the pins placed by time, and a repeat import changes nothing", async () => {
    const origin = await storeHost()
    const phone = client("mini", tab(origin))
    await phone.refresh()
    await phone.pin("session:ses_real")
    const storage = memoryStorage()
    const desktop = client("mini", tab(origin), storage)
    await desktop.refresh()
    const local = [{ ref: "lane:opencode/zeta" }, { ref: "lane:opencode/alpha" }, { ref: "session:ses_mid" }]
    await desktop.migrate(local)
    await phone.refresh()
    expect(orderedPins(phone.state().pins).map((pin) => pin.ref)).toEqual(["session:ses_real", "lane:opencode/zeta", "lane:opencode/alpha", "session:ses_mid"])
    const rev = phone.state().rev
    // The same device again, and a second device importing the same list (same ops): no change.
    await desktop.migrate(local)
    await client("mini", tab(origin)).migrate(local)
    await phone.refresh()
    expect(phone.state().rev).toBe(rev)
    expect(desktop.state().notSynced).toEqual([])
  }, 60_000)

  test.skipIf(!hasOrderIf)("a reorder that lands between the import and its order wins; an unpinned ref stays unpinned", async () => {
    const origin = await storeHost()
    const phone = client("mini", tab(origin))
    await phone.refresh()
    await phone.pin("session:ses_gone")
    await phone.unpin("session:ses_gone")
    // Hold the import's first order change until another client has moved that pin.
    const send = tab(origin)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let paused = false
    const racing = Object.assign(async (input: string, init?: RequestInit) => {
      if (!paused && String(input).endsWith("/order")) {
        paused = true
        await held
      }
      return send(input, init)
    }, { state: send.state })
    const desktop = client("mini", racing)
    await desktop.refresh()
    const migrating = desktop.migrate([{ ref: "lane:opencode/first" }, { ref: "session:ses_gone" }, { ref: "lane:opencode/second" }])
    for (let wait = 10; !paused; wait *= 2) await Bun.sleep(wait)
    await phone.refresh()
    await phone.reorder("lane:opencode/first", -5)
    release()
    await migrating
    await phone.refresh()
    expect(phone.state().pins.map((pin) => [pin.ref, pin.order]).toSorted()).toEqual([["lane:opencode/first", -5], ["lane:opencode/second", 3]])
    expect(desktop.state().notSynced).toEqual([])
  }, 60_000)

  test.skipIf(!hasOrderIf)("an import interrupted offline finishes after a reload with the same changes", async () => {
    const origin = await storeHost()
    const storage = memoryStorage()
    const flaky = tab(origin)
    let sent = 0
    const once = Object.assign(async (input: string, init?: RequestInit) => {
      // The host stops answering after the first import write.
      if (init?.method === "PUT" && ++sent > 1) flaky.state.down = true
      return flaky(input, init)
    }, { state: flaky.state })
    const before = client("mini", once, storage)
    await before.refresh()
    await before.migrate([{ ref: "lane:opencode/one" }, { ref: "lane:opencode/two" }])
    expect(before.state().pending).toBeGreaterThan(0)
    const after = client("mini", tab(origin), storage)
    await after.refresh()
    await after.migrate([{ ref: "lane:opencode/one" }, { ref: "lane:opencode/two" }])
    expect(after.state()).toMatchObject({ pending: 0, notSynced: [] })
    expect(orderedPins(after.state().pins).map((pin) => [pin.ref, pin.order])).toEqual([["lane:opencode/one", 1], ["lane:opencode/two", 2]])
  }, 60_000)

  test("a store that does not understand the precondition gets the import but no order", async () => {
    const origin = await storeHost()
    const plain = tab(origin)
    const older = Object.assign(async (input: string, init?: RequestInit) => {
      const response = await plain(input, init)
      if (!/\/es\/api\/pins(\?|$)/.test(String(input))) return response
      const body = await response.json()
      delete body.orderIf
      return Response.json(body, { status: response.status })
    }, { state: plain.state })
    const desktop = client("mini", older)
    await desktop.refresh()
    await desktop.migrate([{ ref: "lane:opencode/one" }, { ref: "lane:opencode/two" }])
    const reader = client("mini", tab(origin))
    await reader.refresh()
    expect(reader.state().pins.map((pin) => [pin.ref, pin.order]).toSorted()).toEqual([["lane:opencode/one", null], ["lane:opencode/two", null]])
  }, 60_000)

  test.skipIf(!hasOrderIf)("one host reached through two origins imports once: both listeners send the same changes", async () => {
    const origin = await storeHost()
    const local = [{ ref: "lane:opencode/a" }, { ref: "lane:opencode/b" }]
    const own = client("mini", tab(origin))
    const viaLaptop = client("mini", tab(origin))
    await Promise.all([own.refresh(), viaLaptop.refresh()])
    await Promise.all([own.migrate(local), viaLaptop.migrate(local)])
    await own.refresh()
    expect(orderedPins(own.state().pins).map((pin) => [pin.ref, pin.order])).toEqual([["lane:opencode/a", 1], ["lane:opencode/b", 2]])
    expect([own.state().notSynced, viaLaptop.state().notSynced]).toEqual([[], []])
  }, 60_000)

  test("the store refuses a pin write without the CSRF header", async () => {
    const origin = await storeHost()
    const send = tab(origin)
    await send("/es/api/attention/session", { method: "POST", headers: { "content-type": "application/json", "X-Attention-CSRF": "1" }, body: "{}" })
    const response = await send("/es/api/pins/session:ses_a", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"at":1,"op":"op-12345678"}' })
    expect(response.status).toBe(403)
  }, 60_000)
})

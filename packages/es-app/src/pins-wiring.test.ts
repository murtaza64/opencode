import { describe, expect, test } from "bun:test"
import { isRowPinned, legacyPinsCovered, migrateReadyPins, migrationRefs, movePinnedRow, orderingPinsClient, pinnedRows, pinnedUnionRows, pinMigrationReady, rowPinRef } from "./pin-view"
import { createPinsClient, syncableHost, type Pin } from "./pins-sync"

const storage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  } satisfies Storage
}

const hostStore = () => {
  const pins = new Map<string, Pin>()
  const writes: string[] = []
  const orders: number[] = []
  const state = { down: false, profile: "work" }
  const send = async (url: string, init?: RequestInit) => {
    if (state.down) throw new TypeError("host unreachable")
    if (!init?.method) return Response.json({ rev: 1, profile: state.profile, pins: [...pins.values()], tombstones: [], reset: true })
    writes.push(`${init.method} ${url}`)
    const ref = decodeURIComponent(url.split("/pins/")[1]!.replace(/\/order$/, ""))
    const body = JSON.parse(String(init.body)) as { at: number; order?: number }
    if (init.method === "DELETE") pins.delete(ref)
    if (init.method === "PUT") pins.set(ref, { ref, pinnedAt: body.at })
    if (init.method === "PATCH") {
      orders.push(body.order!)
      pins.set(ref, { ...pins.get(ref)!, order: body.order, orderAt: body.at })
    }
    return Response.json({ rev: 2, applied: true, current: pins.has(ref) ? { state: "pinned", ...pins.get(ref) } : { state: "unpinned", at: body.at } })
  }
  return { send, writes, orders, state }
}

describe("dashboard pin wiring", () => {
  test("Local pinned rows come from the host store; a lane pin follows its new owner", async () => {
    const host = hostStore()
    const client = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: host.send, storage: storage(), now: () => 100 })
    await client.refresh()
    const owners = [{ editspace: "opencode", lane: "agent", owner: "ses_new" }]
    await client.pin("lane:opencode/agent")
    expect(isRowPinned({ id: "ses_new", directory: "/a" }, [], owners, client)).toBe(true)
    expect(isRowPinned({ id: "ses_old", directory: "/a" }, [], owners, client)).toBe(false)
    expect(pinnedRows([{ id: "ses_new", directory: "/a" }], owners, client)).toEqual([{ id: "ses_new", directory: "/a", pinnedAt: 100 }])
    expect(rowPinRef({ id: "ses_new", directory: "/a" }, owners)).toBe("lane:opencode/agent")
  })

  test("Work pin writes target only that host even when session ids match", async () => {
    const laptop = hostStore()
    const mini = hostStore()
    const own = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: laptop.send, storage: storage() })
    const remote = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: mini.send, storage: storage() })
    await Promise.all([own.refresh(), remote.refresh()])
    await own.pin("session:ses_same")
    await remote.pin("session:ses_same")
    await remote.unpin("session:ses_same")
    expect(own.state().pins.map((pin) => pin.ref)).toEqual(["session:ses_same"])
    expect(remote.state().pins).toEqual([])
    expect(laptop.writes).toEqual(["PUT /es/api/pins/session:ses_same"])
    expect(mini.writes).toEqual(["PUT /hosts/mini/es/api/pins/session:ses_same", "DELETE /hosts/mini/es/api/pins/session:ses_same"])
  })

  test("an unknown host or unusable client uses the directory/session local cache", async () => {
    const keys = ['["/a","ses_same"]']
    const row = { id: "ses_same", directory: "/b" }
    expect(syncableHost("local")).toBe(false)
    expect(isRowPinned(row, keys, [])).toBe(true)
    const host = hostStore()
    const client = createPinsClient({ host: "mini", prefix: "", profile: "work", fetch: host.send, storage: storage() })
    expect(isRowPinned(row, keys, [], client.state().status === "ready" ? client : undefined)).toBe(true)
    await client.refresh()
    expect(isRowPinned(row, keys, [], client)).toBe(false)
    const down = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: async () => new Response("down", { status: 503 }), storage: storage() })
    await down.refresh()
    expect(down.state().status).toBe("unavailable")
    expect(isRowPinned(row, keys, [], down.state().status === "ready" ? down : undefined)).toBe(true)
  })

  test("legacy Local and Work keys migrate once per host", async () => {
    const cache = storage()
    cache.setItem("es-app-sidebar-pins", '["[\\"/a\\",\\"ses_local\\"]"]')
    cache.setItem("host:mini:es-app-sidebar-pins", '["[\\"/b\\",\\"ses_remote\\"]"]')
    const laptop = hostStore()
    const mini = hostStore()
    const own = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: laptop.send, storage: cache })
    const remote = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: mini.send, storage: cache })
    await Promise.all([own.refresh(), remote.refresh()])
    await own.migrate(migrationRefs(JSON.parse(cache.getItem("es-app-sidebar-pins")!), [], []))
    await remote.migrate(migrationRefs(JSON.parse(cache.getItem("host:mini:es-app-sidebar-pins")!), [], []))
    await own.migrate([{ ref: "session:ses_other" }])
    await remote.migrate([{ ref: "session:ses_other" }])
    expect(laptop.writes).toEqual(["PUT /es/api/pins/session:ses_local"])
    expect(mini.writes).toEqual(["PUT /hosts/mini/es/api/pins/session:ses_remote"])
    expect(cache.getItem("es-pins-migrated:laptop")).not.toBeNull()
    expect(cache.getItem("es-pins-migrated:mini")).not.toBeNull()
    expect(cache.getItem("es-app-sidebar-pins")).not.toBeNull()
  })

  test("lane-owned legacy pins wait for lineage before the one-time import", async () => {
    const cache = storage()
    const host = hostStore()
    const client = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: host.send, storage: cache })
    const keys = ['["/editspaces/opencode","ses_lane"]']
    const rows = [{ id: "ses_lane", directory: "/editspaces/opencode" }]
    await client.refresh()
    await migrateReadyPins(client, { kind: "work", feed: false, lineage: false, legacyPins: true }, keys, rows, [])
    await migrateReadyPins(client, { kind: "work", feed: true, lineage: false, legacyPins: true }, keys, rows, [])
    expect(pinMigrationReady({ kind: "local", dashboard: true, handoffs: false, sessions: true, otherLineages: true })).toBe(false)
    expect(host.writes).toEqual([])
    expect(cache.getItem("es-pins-migrated:mini")).toBeNull()
    const owners = [{ editspace: "opencode", lane: "orchestrator", owner: "ses_lane" }]
    await migrateReadyPins(client, { kind: "work", feed: true, lineage: true, legacyPins: true }, keys, rows, owners)
    expect(host.writes).toEqual(["PUT /hosts/mini/es/api/pins/lane:opencode%2Forchestrator"])
    expect(client.state().pins.map((pin) => pin.ref)).toEqual(["lane:opencode/orchestrator"])
    expect(cache.getItem("es-pins-migrated:mini")).not.toBeNull()

    const localStore = hostStore()
    const local = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: localStore.send, storage: storage() })
    await local.refresh()
    await migrateReadyPins(local, { kind: "local", dashboard: true, handoffs: false, sessions: true, otherLineages: true }, keys, rows, [])
    expect(localStore.writes).toEqual([])
    await migrateReadyPins(local, { kind: "local", dashboard: true, handoffs: true, sessions: true, otherLineages: true }, keys, rows, owners)
    expect(localStore.writes).toEqual(["PUT /es/api/pins/lane:opencode%2Forchestrator"])
  })

  test("single-project Work import waits until all legacy session owners are covered", () => {
    const keys = ['["/one","ses_one"]', '["/two","ses_two"]']
    expect(legacyPinsCovered(keys, [{ id: "ses_one", directory: "/one" }])).toBe(false)
    expect(legacyPinsCovered(keys, [{ id: "ses_one", directory: "/one" }, { id: "ses_two", directory: "/one" }])).toBe(false)
    expect(legacyPinsCovered(keys, [{ id: "ses_one", directory: "/one" }, { id: "ses_two", directory: "/two" }])).toBe(true)
  })

  test("never-moved pins of two hosts interleave newest first", async () => {
    const laptop = hostStore()
    const mini = hostStore()
    const time = { now: 300 }
    const own = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: laptop.send, storage: storage(), now: () => time.now })
    const remote = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: mini.send, storage: storage(), now: () => time.now })
    await Promise.all([own.refresh(), remote.refresh()])
    await own.pin("session:ses_new")
    time.now = 200
    await remote.pin("session:ses_middle")
    time.now = 100
    await own.pin("session:ses_old")
    expect(pinnedUnionRows([
      { host: "laptop", client: own, owners: [], rows: [{ id: "ses_old", directory: "/a" }, { id: "ses_new", directory: "/a" }] },
      { host: "mini", client: remote, owners: [], rows: [{ id: "ses_middle", directory: "/b", host: "mini" }] },
    ]).map((row) => row.id)).toEqual(["ses_new", "ses_middle", "ses_old"])
  })

  test("fallback pins append after the synced union in Local then Work registry order", async () => {
    const mini = hostStore()
    const client = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: mini.send, storage: storage(), now: () => 200 })
    await client.refresh()
    await client.pin("session:ses_synced")
    expect(pinnedUnionRows([
      { host: "laptop", owners: [], rows: [{ id: "ses_local_a", directory: "/a" }, { id: "ses_local_b", directory: "/a" }] },
      { host: "mini", client, owners: [], rows: [{ id: "ses_synced", directory: "/b", host: "mini" }] },
      { host: "other", owners: [], rows: [{ id: "ses_other", directory: "/c", host: "other" }] },
    ]).map((row) => row.id)).toEqual(["ses_synced", "ses_local_a", "ses_local_b", "ses_other"])
  })

  test("Mini pins hold their interleaved place through pin and feed outages, then recover; profile mismatch removes them", async () => {
    const laptop = hostStore()
    const mini = hostStore()
    const time = { now: 300 }
    const own = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: laptop.send, storage: storage(), now: () => time.now })
    const remote = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: mini.send, storage: storage(), now: () => time.now })
    const feed = { status: "ready", rows: [{ id: "ses_mini", directory: "/mini", host: "mini" }] }
    const owners = [{ editspace: "opencode", lane: "worker", owner: "ses_mini" }]
    const groups = () => [
      { host: "laptop", client: orderingPinsClient(own, true), owners: [], rows: [{ id: "ses_new", directory: "/local" }, { id: "ses_old", directory: "/local" }] },
      { host: "mini", client: orderingPinsClient(remote, true), owners, rows: remote.state().reason === "profile" ? [] : feed.rows },
    ]
    await Promise.all([own.refresh(), remote.refresh()])
    await own.pin("session:ses_new")
    time.now = 200
    await remote.pin("lane:opencode/worker")
    time.now = 100
    await own.pin("session:ses_old")
    expect(pinnedUnionRows(groups()).map((row) => row.id)).toEqual(["ses_new", "ses_mini", "ses_old"])
    mini.state.down = true
    await remote.refresh()
    expect(remote.state()).toMatchObject({ status: "unavailable", reason: "network" })
    expect(pinnedUnionRows(groups()).map((row) => row.id)).toEqual(["ses_new", "ses_mini", "ses_old"])
    feed.status = "unavailable"
    expect(feed.status).toBe("unavailable")
    expect(pinnedUnionRows(groups()).map((row) => row.id)).toEqual(["ses_new", "ses_mini", "ses_old"])
    mini.state.down = false
    await remote.refresh()
    feed.status = "ready"
    expect(pinnedUnionRows(groups()).map((row) => row.id)).toEqual(["ses_new", "ses_mini", "ses_old"])
    mini.state.profile = "personal"
    await remote.refresh()
    expect(remote.state()).toMatchObject({ status: "unavailable", reason: "profile", pins: [] })
    expect(orderingPinsClient(remote, true)).toBeUndefined()
    expect(pinnedUnionRows(groups()).map((row) => row.id)).toEqual(["ses_new", "ses_old"])
  })

  test("moving a Work pin between two Local pins changes only Work and survives a fresh read", async () => {
    const laptop = hostStore()
    const mini = hostStore()
    const time = { now: 300 }
    const own = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: laptop.send, storage: storage(), now: () => time.now })
    const remote = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: mini.send, storage: storage(), now: () => time.now })
    const high = { id: "ses_high", directory: "/a" }
    const low = { id: "ses_low", directory: "/a" }
    const moved = { id: "ses_work", directory: "/b", host: "mini" }
    const groups = () => [
      { host: "laptop", client: own, owners: [], rows: [high, low] },
      { host: "mini", client: remote, owners: [], rows: [moved] },
    ]
    await Promise.all([own.refresh(), remote.refresh()])
    await own.pin("session:ses_high")
    time.now = 100
    await own.pin("session:ses_low")
    time.now = 50
    await remote.pin("session:ses_work")
    expect(pinnedUnionRows(groups()).map((row) => row.id)).toEqual(["ses_high", "ses_low", "ses_work"])
    expect(movePinnedRow("laptop", groups(), moved, high, low)).toBe(true)
    await remote.refresh()
    expect(mini.writes.at(-1)).toBe("PATCH /hosts/mini/es/api/pins/session:ses_work/order")
    expect(mini.orders).toEqual([-200])
    expect(laptop.writes).toEqual(["PUT /es/api/pins/session:ses_high", "PUT /es/api/pins/session:ses_low"])
    expect(pinnedUnionRows(groups()).map((row) => row.id)).toEqual(["ses_high", "ses_work", "ses_low"])
    const secondOwn = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: laptop.send, storage: storage() })
    const secondRemote = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: mini.send, storage: storage() })
    await Promise.all([secondOwn.refresh(), secondRemote.refresh()])
    expect(pinnedUnionRows([
      { host: "laptop", client: secondOwn, owners: [], rows: [high, low] },
      { host: "mini", client: secondRemote, owners: [], rows: [moved] },
    ]).map((row) => row.id)).toEqual(["ses_high", "ses_work", "ses_low"])
  })

  test("an offline move queues on its own host and replays; an unusable host cannot move", async () => {
    const laptop = hostStore()
    const mini = hostStore()
    const time = { now: 300 }
    const own = createPinsClient({ host: "laptop", prefix: "", profile: "work", fetch: laptop.send, storage: storage(), now: () => time.now })
    const remote = createPinsClient({ host: "mini", prefix: "/hosts/mini", profile: "work", fetch: mini.send, storage: storage(), now: () => time.now })
    const high = { id: "ses_high", directory: "/a" }
    const low = { id: "ses_low", directory: "/a" }
    const moved = { id: "ses_work", directory: "/b", host: "mini" }
    const groups = () => [
      { host: "laptop", client: own, owners: [], rows: [high, low] },
      { host: "mini", client: remote, owners: [], rows: [moved] },
    ]
    await Promise.all([own.refresh(), remote.refresh()])
    await own.pin("session:ses_high")
    time.now = 100
    await own.pin("session:ses_low")
    time.now = 50
    await remote.pin("session:ses_work")
    mini.state.down = true
    expect(movePinnedRow("laptop", groups(), moved, high, low)).toBe(true)
    expect(remote.state().pending).toBe(1)
    await remote.refresh()
    expect(remote.state().status).toBe("unavailable")
    expect(movePinnedRow("laptop", groups(), moved, high, low)).toBe(false)
    expect(movePinnedRow("laptop", [{ host: "laptop", client: own, owners: [], rows: [high, low] }, { host: "mini", owners: [], rows: [moved] }], moved, high, low)).toBe(false)
    expect(mini.orders).toEqual([])
    mini.state.down = false
    await remote.refresh()
    expect(remote.state().pending).toBe(0)
    expect(mini.orders).toEqual([-200])
    expect(pinnedUnionRows(groups()).map((row) => row.id)).toEqual(["ses_high", "ses_work", "ses_low"])
  })
})

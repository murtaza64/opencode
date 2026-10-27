import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { serve } from "./server"
import { readBadge, watchBadges } from "./badges"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// A host dashboard (behind its gate at /es) with its own attention ledger and pending requests.
const dashboard = (state: { records: unknown[]; notifications: unknown[]; partial?: boolean; projects?: unknown[] }) => {
  const requests: { method: string; path: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname })
      if (url.pathname.endsWith("/api/attention"))
        return Response.json({ records: state.records, projects: state.projects ?? [{ editspace: "dotfiles", available: true }], partial: state.partial ?? false })
      if (url.pathname.endsWith("/api/notifications")) return Response.json({ notifications: state.notifications })
      if (url.pathname.endsWith("/api/editspaces")) return Response.json({ editspaces: [] })
      return Response.json({})
    },
  })
  cleanup.push(async () => void (await server.stop(true)))
  return { origin: server.url.origin, requests, stop: () => server.stop(true) }
}

const listener = async (options: Parameters<typeof serve>[0] extends infer T ? Partial<T> : never) => {
  const root = await mkdtemp(path.join(tmpdir(), "es-desktop-badges-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture</title>")
  const server = await serve({ root, ...options })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  return { id: "host", read: (pathname: string) => fetch(`${server.origin}${pathname}`, { headers: { "x-editspace-key": server.key, origin: server.origin } }) }
}

const open = (id: string) => ({ id, status: "open", editspace: "dotfiles" })

test("each host's count comes from its own ledger, with the same record IDs on both hosts", async () => {
  const local = dashboard({ records: [open("same"), { id: "done", status: "resolved" }], notifications: [{ kind: "idle" }] })
  const mini = dashboard({ records: [open("same"), open("other")], notifications: [{ kind: "permission" }, { kind: "question" }, { kind: "idle" }] })
  const localHost = await listener({ opencode: local.origin, dashboard: local.origin })
  const miniHost = await listener({ remote: { id: "mini", origin: mini.origin } })
  expect(await readBadge(localHost)).toEqual({ count: 1, partial: false })
  expect(await readBadge(miniHost)).toEqual({ count: 4, partial: false })
  expect(mini.requests.every((item) => item.method === "GET" && item.path.startsWith("/es/api/"))).toBe(true)
})

test("an unreachable host or unreadable ledger is unavailable, never zero", async () => {
  const mini = dashboard({ records: [], notifications: [] })
  const host = await listener({ remote: { id: "mini", origin: mini.origin } })
  expect(await readBadge(host)).toEqual({ count: 0, partial: false })
  await mini.stop()
  expect(await readBadge(host)).toBe("unavailable")
  const down = dashboard({ records: [], notifications: [], projects: [{ editspace: "dotfiles", available: false }] })
  expect(await readBadge(await listener({ remote: { id: "mini", origin: down.origin } }))).toBe("unavailable")
})

test("a partial ledger or missing request list is marked partial", async () => {
  const partial = dashboard({ records: [open("a")], notifications: [], partial: true })
  expect(await readBadge(await listener({ remote: { id: "mini", origin: partial.origin } }))).toEqual({ count: 1, partial: true })
})

test("the watcher reads each host once per interval, one read in flight, and reports reconnects", async () => {
  const state = { records: [open("a")], notifications: [] as unknown[] }
  const mini = dashboard(state)
  const host = await listener({ remote: { id: "mini", origin: mini.origin } })
  const seen: unknown[] = []
  const watcher = watchBadges([{ ...host, id: "mini" }], (_id, badge) => seen.push(badge), 200)
  await Bun.sleep(50)
  state.records.push(open("b"))
  await Bun.sleep(230)
  watcher.stop()
  expect(seen).toEqual([{ count: 1, partial: false }, { count: 2, partial: false }])
  // Two small GETs per read: the whole idle budget.
  expect(mini.requests.map((item) => item.path).sort()).toEqual(["/es/api/attention", "/es/api/attention", "/es/api/notifications", "/es/api/notifications"])
})

test("no reads while the window is hidden; showing it reads once", async () => {
  const mini = dashboard({ records: [open("a")], notifications: [] })
  const host = await listener({ remote: { id: "mini", origin: mini.origin } })
  const state = { visible: false }
  const seen: unknown[] = []
  const watcher = watchBadges([{ ...host, id: "mini" }], (_id, badge) => seen.push(badge), 1000, () => state.visible)
  await Bun.sleep(1100)
  expect(mini.requests).toEqual([])
  state.visible = true
  watcher.refresh()
  await Bun.sleep(30)
  watcher.stop()
  expect(seen).toEqual([{ count: 1, partial: false }])
})

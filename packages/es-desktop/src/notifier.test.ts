import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { serve } from "./server"
import { muxEvents, route, sseEvents, watchNotifications, type NotifyHost } from "./notifier"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

type Record = { id: string; editspace: string; status: string; revision: number; content_revision?: number; title: string; delivery_state?: string; answer?: { answered_at: number } }

// A host dashboard with an attention ledger, pending requests and the nudge stream.
const dashboard = () => {
  const state = { records: [] as Record[], notifications: [] as unknown[], unavailable: false, failing: false, legacy: false }
  const reads: string[] = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      // A remote host is a gateway serving the dashboard under /es.
      url.pathname = url.pathname.replace(/^\/es\//, "/")
      if (url.pathname === "/api/notification-events")
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              streams.add(controller)
              controller.enqueue(new TextEncoder().encode("data: connected\n\n"))
            },
            cancel: () => undefined,
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      reads.push(url.pathname + url.search)
      if (state.failing) return new Response("bad gateway", { status: 502 })
      if (url.pathname === "/api/attention") {
        const statuses = { open: ["open"], answered: ["answered"], recorded: ["decided"] }[url.searchParams.get("view") ?? "open"] ?? []
        const records = state.unavailable ? [] : state.records.filter((item) => statuses.includes(item.status))
        // Dashboards older than per-project availability send records only.
        if (state.legacy) return Response.json({ records })
        return Response.json({ records, projects: [{ editspace: "opencode", available: !state.unavailable }], partial: state.unavailable })
      }
      if (url.pathname === "/api/notifications") return Response.json({ notifications: state.notifications })
      if (url.pathname === "/api/editspaces") return Response.json({ editspaces: [] })
      return Response.json({})
    },
  })
  cleanup.push(async () => void (await server.stop(true)))
  const nudge = (kind: string) => {
    for (const controller of streams) controller.enqueue(new TextEncoder().encode(`data: ${kind}\n\n`))
  }
  return { origin: server.url.origin, state, reads, nudge }
}

// The real desktop listener in front of the dashboard, read the way main.ts reads a remote host.
const host = async (id: string, dashboardOrigin: string): Promise<NotifyHost> => {
  const root = await mkdtemp(path.join(tmpdir(), "es-desktop-notify-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await Bun.write(path.join(root, "index.html"), "<title>Fixture</title>")
  const server = await serve({ root, remote: { id, origin: dashboardOrigin } })
  cleanup.push(() => Promise.race([server.close(), Bun.sleep(500)]))
  return {
    id,
    read: (pathname, signal) => fetch(`${server.origin}${pathname}`, { headers: { "x-editspace-key": server.key, origin: server.origin }, signal }),
    events: muxEvents(server.origin, server.key),
  }
}

// A page host: the gateway read directly over HTTP server-sent events.
const page = (id: string, dashboardOrigin: string): NotifyHost => {
  const read = (pathname: string, signal?: AbortSignal) => fetch(`${dashboardOrigin}${pathname.replace(/^\/es/, "")}`, { signal })
  return { id, read, events: sseEvents(read) }
}

const decision = (id: string, revision = 1, title = "Pick a reviewer"): Record => ({ id, editspace: "opencode", status: "open", revision, content_revision: revision, title })

const watch = (hosts: NotifyHost[], focused: { value: boolean; host?: string } = { value: false }) => {
  const shown: { tag: string; title: string; host: string; route: string | undefined; closed: boolean }[] = []
  const watcher = watchNotifications(hosts, {
    focused: (host) => focused.value && (!("host" in focused) || focused.host === host),
    show: (notice) => {
      const item = { tag: notice.tag, title: notice.title, host: notice.host, route: notice.route, closed: false }
      shown.push(item)
      return { close: () => (item.closed = true) }
    },
    retry: 50,
  })
  cleanup.push(async () => watcher.stop())
  return { shown, open: () => shown.filter((item) => !item.closed) }
}

const settle = () => Bun.sleep(150)

test("what is already waiting at launch does not notify; a new decision after a nudge does", async () => {
  const mini = dashboard()
  mini.state.records.push(decision("00000000-0000-4000-8000-000000000001"))
  const notices = watch([await host("mini", mini.origin)])
  await settle()
  expect(notices.shown).toEqual([])
  mini.state.records.push(decision("00000000-0000-4000-8000-000000000002"))
  mini.nudge("attention")
  await settle()
  expect(notices.open().map((item) => [item.tag, item.route, item.host])).toEqual([
    ["mini|opencode|att:00000000-0000-4000-8000-000000000002", "/?item=attention%3Aopencode%3A00000000-0000-4000-8000-000000000002", "mini"],
  ])
})

test("answering elsewhere closes the notification; a repeated nudge never duplicates it", async () => {
  const mini = dashboard()
  const notices = watch([await host("mini", mini.origin)])
  await settle()
  mini.state.records.push(decision("00000000-0000-4000-8000-000000000003"))
  mini.nudge("attention")
  mini.nudge("attention")
  await settle()
  mini.nudge("refresh")
  await settle()
  expect(notices.shown.map((item) => item.tag)).toEqual(["mini|opencode|att:00000000-0000-4000-8000-000000000003"])
  mini.state.records[0] = { ...mini.state.records[0]!, status: "answered", revision: 2, answer: { answered_at: Date.now() } }
  mini.nudge("attention")
  await settle()
  expect(notices.open()).toEqual([])
})

test("a native permission request notifies and routes to its session", async () => {
  const mini = dashboard()
  const notices = watch([await host("mini", mini.origin)])
  await settle()
  mini.state.notifications.push({ id: "per_1", kind: "permission", editspace: "opencode", session: "ses_1", title: "Edit file", directory: "/x" })
  mini.state.notifications.push({ id: "idle:ses_2", kind: "idle", editspace: "opencode", session: "ses_2", title: "Done", directory: "/x" })
  mini.nudge("refresh")
  await settle()
  expect(notices.open().map((item) => [item.tag, item.route])).toEqual([["mini|opencode|req:per_1", "/session/ses_1"]])
})

test("a focused window posts nothing and does not replay on blur", async () => {
  const mini = dashboard()
  const focused = { value: true }
  const notices = watch([await host("mini", mini.origin)], focused)
  await settle()
  mini.state.records.push(decision("00000000-0000-4000-8000-000000000004"))
  mini.nudge("attention")
  await settle()
  focused.value = false
  mini.nudge("attention")
  await settle()
  expect(notices.shown).toEqual([])
})

test("an unreadable project keeps its notification; one host never closes another's", async () => {
  const local = dashboard()
  const mini = dashboard()
  const notices = watch([await host("local", local.origin), await host("mini", mini.origin)])
  await settle()
  local.state.records.push(decision("00000000-0000-4000-8000-000000000005"))
  mini.state.records.push(decision("00000000-0000-4000-8000-000000000005"))
  local.nudge("attention")
  mini.nudge("attention")
  await settle()
  expect(notices.open().map((item) => item.host).sort()).toEqual(["local", "mini"])
  mini.state.unavailable = true
  mini.nudge("attention")
  local.state.records.length = 0
  local.nudge("attention")
  await settle()
  expect(notices.open().map((item) => item.host)).toEqual(["mini"])
})

test("reads happen only on stream events: no timer", async () => {
  const mini = dashboard()
  watch([await host("mini", mini.origin)])
  await settle()
  const initial = mini.reads.length
  await Bun.sleep(400)
  expect(mini.reads.length).toBe(initial)
  // One connect read = requests + three attention views.
  expect(initial).toBe(4)
})

test("a page host read over server-sent events notifies the same way", async () => {
  const gateway = dashboard()
  const notices = watch([page("page", gateway.origin)])
  await settle()
  gateway.state.records.push(decision("00000000-0000-4000-8000-000000000006"))
  gateway.nudge("attention")
  await settle()
  expect(notices.open().map((item) => item.tag)).toEqual(["page|opencode|att:00000000-0000-4000-8000-000000000006"])
})

test("a click route is built only from well-formed IDs", () => {
  const notice = { kind: "decision" as const, editspace: "opencode", id: "00000000-0000-4000-8000-000000000007", title: "t" }
  expect(route(notice)).toBe("/?item=attention%3Aopencode%3A00000000-0000-4000-8000-000000000007")
  expect(route({ ...notice, id: "../x" })).toBeUndefined()
  expect(route({ ...notice, editspace: "//evil.test" })).toBeUndefined()
  expect(route({ kind: "permission", editspace: "opencode", id: "per_1", session: "ses_1/../../x", title: "t" })).toBeUndefined()
  expect(route({ kind: "question", editspace: "opencode", id: "q_1", session: "ses_Ab1", title: "t" })).toBe("/session/ses_Ab1")
})

test("a page host that redirects to sign-in is unavailable: nothing notifies, nothing is followed", async () => {
  const signin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { location: "https://login.example/" } }) })
  cleanup.push(async () => void (await signin.stop(true)))
  const read = (pathname: string, signal?: AbortSignal) => fetch(`${signin.url.origin}${pathname}`, { redirect: "manual", signal })
  const notices = watch([{ id: "page", read, events: sseEvents(read) }])
  await settle()
  expect(notices.shown).toEqual([])
})

test("a failed first read keeps the launch baseline: the next good read replays nothing", async () => {
  const mini = dashboard()
  mini.state.failing = true
  mini.state.records.push(decision("00000000-0000-4000-8000-000000000008"))
  mini.state.notifications.push({ id: "per_old", kind: "permission", editspace: "opencode", session: "ses_old", title: "Old", directory: "/x" })
  const notices = watch([await host("mini", mini.origin)])
  await settle()
  mini.state.failing = false
  mini.nudge("attention")
  await settle()
  expect(notices.shown).toEqual([])
  mini.state.records.push(decision("00000000-0000-4000-8000-000000000009"))
  mini.nudge("attention")
  await settle()
  expect(notices.open().map((item) => item.tag)).toEqual(["mini|opencode|att:00000000-0000-4000-8000-000000000009"])
})

test("a project unavailable at launch does not replay its backlog when it becomes readable", async () => {
  const mini = dashboard()
  mini.state.unavailable = true
  mini.state.records.push(decision("00000000-0000-4000-8000-00000000000a"))
  const notices = watch([await host("mini", mini.origin)])
  await settle()
  mini.state.unavailable = false
  mini.nudge("attention")
  await settle()
  expect(notices.shown).toEqual([])
  mini.state.records.push(decision("00000000-0000-4000-8000-00000000000b"))
  mini.nudge("attention")
  await settle()
  expect(notices.open().map((item) => item.tag)).toEqual(["mini|opencode|att:00000000-0000-4000-8000-00000000000b"])
})

test("a focused window still notifies for a host whose tab is not shown", async () => {
  const local = dashboard()
  const mini = dashboard()
  const notices = watch([await host("local", local.origin), await host("mini", mini.origin)], { value: true, host: "local" })
  await settle()
  local.state.records.push(decision("00000000-0000-4000-8000-00000000000c"))
  mini.state.records.push(decision("00000000-0000-4000-8000-00000000000d"))
  local.nudge("attention")
  mini.nudge("attention")
  await settle()
  expect(notices.open().map((item) => item.host)).toEqual(["mini"])
})

test("a dashboard without a projects list still notifies a new decision after the launch baseline", async () => {
  const mini = dashboard()
  mini.state.legacy = true
  mini.state.records.push(decision("00000000-0000-4000-8000-00000000000e"))
  const notices = watch([await host("mini", mini.origin)])
  await settle()
  expect(notices.shown).toEqual([])
  mini.state.records.push(decision("00000000-0000-4000-8000-00000000000f"))
  mini.nudge("attention")
  await settle()
  expect(notices.open().map((item) => item.tag)).toEqual(["mini|opencode|att:00000000-0000-4000-8000-00000000000f"])
})

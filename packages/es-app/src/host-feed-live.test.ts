import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test"
import { createRoot } from "solid-js"
import { createHostFeed } from "./host-feed"

// That host's event stream, as the Local listener delivers it (global envelope).
class HostEvents {
  static all: HostEvents[] = []
  onmessage?: (event: { data: string }) => void
  onopen?: () => void
  onerror?: () => void
  constructor(readonly url: string) {
    HostEvents.all.push(this)
  }
  close() {}
  status(sessionID: string, type: string) {
    this.onmessage?.({ data: JSON.stringify({ payload: { type: "session.status", properties: { sessionID, status: { type } } } }) })
  }
}

// Each host's Core: its root sessions and its status list (which names only sessions that are not idle).
// A session's directory defaults to /r. Like Core, a status read answers only for the directory it names (one Instance
// per directory); a read without one names no session here.
let cores: Record<string, { sessions: { id: string; directory?: string }[]; status: Record<string, unknown>; gate?: Promise<void>; statusDown?: boolean | string }>
let fetchSpy: Mock<(input: RequestInfo | URL) => Promise<Response>>
let original: PropertyDescriptor | undefined
const disposers: (() => void)[] = []

beforeEach(() => {
  HostEvents.all = []
  // The periodic read runs only while the page is visible.
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible" } })
  original = Object.getOwnPropertyDescriptor(globalThis, "EventSource")
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: HostEvents })
  fetchSpy = spyOn(globalThis, "fetch")
  fetchSpy.mockImplementation(async (input) => {
    const url = new URL(String(input), "http://listener")
    const [, host, path] = /^\/hosts\/([^/]+)(\/.*)$/.exec(url.pathname)!
    const core = cores[host!]!
    if (path === "/oc/experimental/session") return Response.json(core.sessions.map((item) => ({ ...item, title: item.id, directory: item.directory ?? "/r", time: { created: 1, updated: 1 } })))
    if (path === "/oc/session/status") {
      await core.gate
      const directory = url.searchParams.get("directory")
      if (core.statusDown === true || core.statusDown === directory) return new Response("down", { status: 503 })
      const here = new Set(core.sessions.filter((item) => (item.directory ?? "/r") === directory).map((item) => item.id))
      return Response.json(Object.fromEntries(Object.entries(core.status).filter(([id]) => here.has(id))))
    }
    return Response.json({}, { status: 404 })
  })
})

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  Reflect.deleteProperty(globalThis, "document")
  fetchSpy.mockRestore()
  if (original) Object.defineProperty(globalThis, "EventSource", original)
  else Reflect.deleteProperty(globalThis, "EventSource")
})

const feed = (id: string, every?: number) => createRoot((dispose) => {
  disposers.push(dispose)
  return createHostFeed({ id, label: id, origin: `http://127.0.0.1:${id === "mini" ? 1 : 2}` }, () => undefined, undefined, undefined, every)
})
const settled = async (check: () => boolean) => {
  for (let wait = 5; !check(); wait *= 2) {
    if (wait > 2000) throw new Error("not settled")
    await Bun.sleep(wait)
  }
}

test("a session already busy on another host shows busy as soon as its list is read, before any event", async () => {
  cores = { mini: { sessions: [{ id: "ses_busy" }, { id: "ses_idle" }], status: { ses_busy: { type: "busy" } } } }
  const mini = feed("mini")
  await settled(() => mini.state().status === "ready")
  expect([mini.live("ses_busy"), mini.live("ses_idle")]).toEqual(["busy", "idle"])
})

test("a status event that arrives while the status read is in flight wins over that read", async () => {
  let release!: () => void
  cores = { mini: { sessions: [{ id: "ses_a" }], status: { ses_a: { type: "busy" } }, gate: new Promise((resolve) => (release = resolve)) } }
  const mini = feed("mini")
  await settled(() => HostEvents.all.length === 1 && fetchSpy.mock.calls.some(([input]) => String(input).includes("/oc/session/status")))
  HostEvents.all[0]!.status("ses_a", "idle")
  release()
  await settled(() => mini.state().status === "ready")
  expect(mini.live("ses_a")).toBe("idle")
})

test("a reconnect reads statuses again, so a transition missed while the stream was down is shown", async () => {
  cores = { mini: { sessions: [{ id: "ses_a" }], status: { ses_a: { type: "busy" } } } }
  const mini = feed("mini")
  await settled(() => mini.live("ses_a") === "busy")
  cores.mini!.status = {}
  const stream = HostEvents.all[0]!
  stream.onerror?.()
  stream.onopen?.()
  await settled(() => mini.live("ses_a") === "idle")
})

test("the same session id on two hosts keeps each host's own status", async () => {
  cores = { mini: { sessions: [{ id: "ses_same" }], status: { ses_same: { type: "busy" } } }, wing: { sessions: [{ id: "ses_same" }], status: {} } }
  const mini = feed("mini")
  const wing = feed("wing")
  await settled(() => mini.state().status === "ready" && wing.state().status === "ready")
  expect([mini.live("ses_same"), wing.live("ses_same")]).toEqual(["busy", "idle"])
})

test("a missed idle event clears at the next periodic status read, without a reconnect; a real busy stays busy", async () => {
  cores = { mini: { sessions: [{ id: "ses_done" }, { id: "ses_working" }], status: { ses_done: { type: "busy" }, ses_working: { type: "busy" } } } }
  const mini = feed("mini", 50)
  await settled(() => mini.live("ses_done") === "busy")
  // The session went idle on that host; its idle event never arrived.
  cores.mini!.status = { ses_working: { type: "busy" } }
  await settled(() => mini.live("ses_done") === "idle")
  expect(mini.live("ses_working")).toBe("busy")
  expect(HostEvents.all.length).toBe(1)
})

test("when the status read fails the status is unknown, never the last busy or a guessed idle, until a read succeeds", async () => {
  cores = { mini: { sessions: [{ id: "ses_a" }], status: { ses_a: { type: "busy" } } } }
  const mini = feed("mini", 50)
  await settled(() => mini.live("ses_a") === "busy")
  cores.mini!.statusDown = true
  await settled(() => mini.live("ses_a") === "unknown")
  cores.mini!.statusDown = false
  cores.mini!.status = {}
  await settled(() => mini.live("ses_a") === "idle")
})

test("sessions in different directories are each read in their own directory, so a busy one is never reported idle", async () => {
  cores = { mini: { sessions: [{ id: "ses_lane_a", directory: "/es/lanes/a" }, { id: "ses_lane_b", directory: "/es/lanes/b" }, { id: "ses_quiet", directory: "/es/lanes/b" }],
    status: { ses_lane_a: { type: "busy" }, ses_lane_b: { type: "busy" } } } }
  const mini = feed("mini", 30)
  await settled(() => mini.live("ses_lane_a") === "busy" && mini.live("ses_lane_b") === "busy")
  // Several periodic reads later, with no event at all, both are still busy and the quiet one idle.
  await Bun.sleep(200)
  expect([mini.live("ses_lane_a"), mini.live("ses_lane_b"), mini.live("ses_quiet")]).toEqual(["busy", "busy", "idle"])
})

test("a long silent turn stays busy through periodic reads until that host says the turn ended", async () => {
  cores = { mini: { sessions: [{ id: "ses_thinking", directory: "/es/lanes/a" }], status: { ses_thinking: { type: "busy" } } } }
  const mini = feed("mini", 20)
  await settled(() => mini.live("ses_thinking") === "busy")
  // Long thinking, then a tool call awaiting: no events, Core still reports busy at every read.
  for (let read = 0; read < 10; read++) {
    await Bun.sleep(20)
    expect(mini.live("ses_thinking")).toBe("busy")
  }
  cores.mini!.status = {}
  await settled(() => mini.live("ses_thinking") === "idle")
})

test("a directory whose status cannot be read shows its sessions unknown; others keep their state; the next good read corrects", async () => {
  cores = { mini: { sessions: [{ id: "ses_a", directory: "/es/lanes/a" }, { id: "ses_b", directory: "/es/lanes/b" }], status: { ses_a: { type: "busy" }, ses_b: { type: "busy" } } } }
  const mini = feed("mini", 30)
  await settled(() => mini.live("ses_a") === "busy" && mini.live("ses_b") === "busy")
  cores.mini!.statusDown = "/es/lanes/a"
  await settled(() => mini.live("ses_a") === "unknown")
  expect(mini.live("ses_b")).toBe("busy")
  cores.mini!.statusDown = false
  await settled(() => mini.live("ses_a") === "busy")
})

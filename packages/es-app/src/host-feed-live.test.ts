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
let cores: Record<string, { sessions: { id: string }[]; status: Record<string, unknown>; gate?: Promise<void> }>
let fetchSpy: Mock<(input: RequestInfo | URL) => Promise<Response>>
let original: PropertyDescriptor | undefined
const disposers: (() => void)[] = []

beforeEach(() => {
  HostEvents.all = []
  original = Object.getOwnPropertyDescriptor(globalThis, "EventSource")
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: HostEvents })
  fetchSpy = spyOn(globalThis, "fetch")
  fetchSpy.mockImplementation(async (input) => {
    const [, host, path] = /^\/hosts\/([^/]+)(\/[^?]*)/.exec(String(input))!
    const core = cores[host!]!
    if (path === "/oc/experimental/session") return Response.json(core.sessions.map((item) => ({ ...item, title: item.id, directory: "/r", time: { created: 1, updated: 1 } })))
    if (path === "/oc/session/status") {
      await core.gate
      return Response.json(core.status)
    }
    return Response.json({}, { status: 404 })
  })
})

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  fetchSpy.mockRestore()
  if (original) Object.defineProperty(globalThis, "EventSource", original)
  else Reflect.deleteProperty(globalThis, "EventSource")
})

const feed = (id: string) => createRoot((dispose) => {
  disposers.push(dispose)
  return createHostFeed({ id, label: id, origin: `http://127.0.0.1:${id === "mini" ? 1 : 2}` }, () => undefined)
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

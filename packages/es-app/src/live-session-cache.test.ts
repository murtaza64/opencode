import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test"
import { createRoot } from "solid-js"
import { clearLiveSessions, LIVE_SESSION_CACHE, useLiveSession } from "./live-session-cache"

class Events {
  static all: Events[] = []
  onmessage?: (event: { data: string }) => void
  onopen?: () => void
  onerror?: () => void
  closed = false
  constructor(readonly url: string) {
    Events.all.push(this)
  }
  close() {
    this.closed = true
  }
}

let fetchSpy: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
let originalSource: PropertyDescriptor | undefined
const mounts: (() => void)[] = []

const mount = (id: string, onEvent?: (event: { type: string }) => void) =>
  createRoot((dispose) => {
    mounts.push(dispose)
    return { live: useLiveSession(id, "/repo", onEvent), unmount: dispose }
  })

beforeEach(() => {
  Events.all = []
  originalSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource")
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Events })
  fetchSpy = spyOn(globalThis, "fetch")
  fetchSpy.mockImplementation(async (input) => {
    const path = String(input).split("?")[0]!
    const id = path.split("/")[3]
    if (path.endsWith("/message")) return Response.json([{ info: { id: "msg_1", sessionID: id, role: "user", time: { created: 1 } }, parts: [] }])
    if (path === "/oc/session/status") return Response.json({})
    if (path.endsWith("/todo")) return Response.json([])
    return Response.json({ id, title: id })
  })
})

afterEach(() => {
  mounts.splice(0).forEach((dispose) => dispose())
  clearLiveSessions()
  fetchSpy.mockRestore()
  if (originalSource) Object.defineProperty(globalThis, "EventSource", originalSource)
  else Reflect.deleteProperty(globalThis, "EventSource")
})

test("remounting a recently viewed session reuses its loaded transcript", async () => {
  const first = mount("ses_a")
  await first.live.load()
  first.unmount()
  const again = mount("ses_a")
  expect(again.live).toBe(first.live)
  expect(again.live.loaded()).toBe(true)
  expect(again.live.data.message.ses_a?.map((message) => message.id)).toEqual(["msg_1"])
})

test("events reach only the currently mounted view's listener", async () => {
  const seen: string[] = []
  const first = mount("ses_a", (event) => { seen.push(`first:${event.type}`) })
  first.unmount()
  mount("ses_a", (event) => { seen.push(`second:${event.type}`) })
  Events.all[0]!.onmessage?.({ data: JSON.stringify({ type: "todo.updated", properties: { sessionID: "ses_a", todos: [] } }) })
  await Promise.resolve()
  expect(seen).toEqual(["second:todo.updated"])
})

test("the oldest unmounted sessions are released beyond the cache size; mounted ones never are", () => {
  const pinned = mount("ses_pinned")
  Array.from({ length: LIVE_SESSION_CACHE + 2 }, (_, index) => mount(`ses_${index}`).unmount())
  // Sources open in mount order: pinned, then ses_0..ses_9. Eleven stores exceed the cap by three.
  expect(Events.all.flatMap((source, index) => source.closed ? [index] : [])).toEqual([1, 2, 3])
  expect(mount("ses_pinned").live).toBe(pinned.live)
})

test("leaving a session aborts its in-flight snapshot quietly and reloads on return", async () => {
  const signals: AbortSignal[] = []
  fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/message")) {
      signals.push(init!.signal!)
      return new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    }
    return Promise.resolve(Response.json(String(input).includes("/status") ? {} : String(input).includes("/todo") ? [] : { id: "ses_a" }))
  })
  const first = mount("ses_a")
  void first.live.load().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 250))
  first.unmount()
  expect(signals.at(-1)!.aborted).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(first.live.connectionError()).toBe("")
  const again = mount("ses_a")
  void again.live.load().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(signals).toHaveLength(2)
  expect(signals[1]!.aborted).toBe(false)
})

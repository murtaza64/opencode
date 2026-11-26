import { afterEach, expect, test } from "bun:test"
import { createEventHub } from "./event-source"

const previous = Object.getOwnPropertyDescriptor(globalThis, "EventSource")
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "EventSource", previous)
  else Reflect.deleteProperty(globalThis, "EventSource")
})

test("uses native event streams when the protected origin has no mux capability", async () => {
  const opened: string[] = []
  const closed: string[] = []
  class Native {
    onopen = null
    onerror = null
    onmessage = null
    constructor(readonly url: string) { opened.push(url) }
    close() { closed.push(this.url) }
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Native })
  const hub = createEventHub(() => { throw new Error("Unavailable socket should not be attempted") }, Promise.resolve(false))
  const source = hub.subscribe("/oc/event?directory=%2Ffixture")
  await Promise.resolve()
  expect(opened).toEqual(["/oc/event?directory=%2Ffixture"])
  hub.pause()
  expect(closed).toEqual(opened)
  hub.resume()
  expect(opened).toHaveLength(2)
  source.close()
  expect(closed).toEqual(opened)
  hub.close()
})

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  listeners: (() => void)[] = []
  constructor() { FakeSocket.all.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  addEventListener(_type: "close", listener: () => void) { this.listeners.push(listener) }
  // Closing is asynchronous, as in a browser: CLOSING until the peer answers.
  close() { if (this.readyState < 2) this.readyState = 2 }
  finishClose() { this.readyState = 3; this.listeners.forEach((listener) => listener()); this.onclose?.({ code: 1000, reason: "" }) }
  accept() { this.readyState = 1; this.onopen?.() }
  deliver(message: object) { this.onmessage?.({ data: JSON.stringify(message) }) }
}
const socketHub = (retryMs = 1000) => {
  FakeSocket.all = []
  return createEventHub(() => new FakeSocket() as unknown as WebSocket, Promise.resolve(true), retryMs)
}
const subscribes = (socket: FakeSocket) => socket.sent.filter((message) => message.type === "subscribe")

test("subscribers of the same URL share one upstream subscription, each filtered by its own types (DD #922)", async () => {
  const hub = socketHub()
  const sessions: string[] = []
  const activity: string[] = []
  const a = hub.subscribe("/hosts/mini/oc/global/event", { types: ["session."] })
  a.onmessage = (event) => activity.push(JSON.parse(event.data).payload.type)
  await Promise.resolve()
  const socket = FakeSocket.all[0]!
  socket.accept()
  socket.deliver({ id: 0, type: "open" })
  const b = hub.subscribe("/hosts/mini/oc/global/event", { types: ["session.", "message."] })
  let joinedOpen = 0
  b.onopen = () => joinedOpen++
  b.onmessage = (event) => sessions.push(JSON.parse(event.data).payload.type)
  await Promise.resolve()
  // One subscription id; the wider filter re-sent on the same id, never a second upstream.
  expect(new Set(subscribes(socket).map((message) => message.id))).toEqual(new Set([0]))
  expect(subscribes(socket).at(-1)!.types).toEqual(["message.", "session."])
  expect(joinedOpen).toBe(1)
  socket.deliver({ id: 0, type: "message", data: JSON.stringify({ directory: "/d", payload: { type: "message.updated" } }), lastEventId: "1" })
  socket.deliver({ id: 0, type: "message", data: JSON.stringify({ directory: "/d", payload: { type: "session.status" } }), lastEventId: "2" })
  expect(activity).toEqual(["session.status"])
  expect(sessions).toEqual(["message.updated", "session.status"])
  a.close()
  expect(socket.sent.some((message) => message.type === "unsubscribe")).toBe(false)
  b.close()
  expect(socket.sent.filter((message) => message.type === "unsubscribe")).toEqual([{ type: "unsubscribe", id: 0 }])
  hub.close()
})

test("ten sessions in a few directories stay well under the mux's 16-stream cap", async () => {
  const hub = socketHub()
  hub.subscribe("/oc/global/event", { types: ["session."] })
  hub.subscribe("/hosts/mini/oc/global/event", { types: ["session."] })
  for (let index = 0; index < 10; index++) hub.subscribe(`/oc/event?directory=${encodeURIComponent(`/repo/${index % 3}`)}`, { types: ["message."] })
  for (let index = 0; index < 3; index++) hub.subscribe("/hosts/mini/oc/global/event", { types: ["message."] })
  await Promise.resolve()
  FakeSocket.all[0]!.accept()
  // 1 local global + 1 per open directory (3) + 1 per other host: 5 upstream subscriptions, not 15.
  expect(new Set(subscribes(FakeSocket.all[0]!).map((message) => message.id)).size).toBe(5)
  hub.close()
})

test("a dropped socket reconnects with backoff, reset once a socket opens", async () => {
  const hub = socketHub(10)
  hub.subscribe("/oc/global/event")
  await Promise.resolve()
  const times: number[] = []
  const started = Date.now()
  for (let attempt = 0; attempt < 3; attempt++) {
    const socket = FakeSocket.all.at(-1)!
    socket.readyState = 3
    socket.onclose?.({ code: 1006, reason: "" })
    const count = FakeSocket.all.length
    while (FakeSocket.all.length === count) await Bun.sleep(2)
    times.push(Date.now() - started)
  }
  // 10, then 20, then 40 ms apart (cumulative >= 70 ms).
  expect(times[2]!).toBeGreaterThanOrEqual(65)
  FakeSocket.all.at(-1)!.accept()
  // An accept alone does not reset the backoff (a server closing at once with 1013 would loop every second); a served
  // stream does.
  FakeSocket.all.at(-1)!.deliver({ id: 0, type: "open" })
  const socket = FakeSocket.all.at(-1)!
  socket.readyState = 3
  socket.onclose?.({ code: 1006, reason: "" })
  const count = FakeSocket.all.length
  const reopened = Date.now()
  while (FakeSocket.all.length === count) await Bun.sleep(2)
  expect(Date.now() - reopened).toBeLessThan(30)
  hub.close()
})

test("hiding and showing again never overlaps the old socket with a new one", async () => {
  const hub = socketHub()
  hub.subscribe("/oc/global/event")
  await Promise.resolve()
  const first = FakeSocket.all[0]!
  first.accept()
  hub.pause()
  hub.resume()
  // The first socket is still closing: no second socket yet.
  expect(FakeSocket.all).toHaveLength(1)
  first.finishClose()
  expect(FakeSocket.all).toHaveLength(2)
  hub.close()
})

test("on a gateway page without the mux, subscribers of one URL share one native EventSource", async () => {
  const opened: string[] = []
  class Native {
    onopen: ((event: Event) => void) | null = null
    onerror = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    constructor(readonly url: string) { opened.push(url) }
    close() {}
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Native })
  const hub = createEventHub(() => { throw new Error("no socket") }, Promise.resolve(false))
  hub.subscribe("/oc/global/event", { types: ["session."] })
  hub.subscribe("/oc/global/event", { types: ["message."] })
  hub.subscribe("/oc/event?directory=%2Fa")
  hub.subscribe("/oc/event?directory=%2Fa")
  await Promise.resolve()
  expect(opened).toEqual(["/oc/global/event", "/oc/event?directory=%2Fa"])
  hub.close()
})

test("more than 16 prefixes on one stream go unfiltered upstream, each listener still filtered for itself", async () => {
  const hub = socketHub()
  const seen: string[] = []
  for (let index = 0; index < 17; index++) {
    const source = hub.subscribe("/oc/global/event", { types: [`kind${index}.`] })
    source.onmessage = (event) => seen.push(`${index}:${JSON.parse(event.data).payload.type}`)
  }
  await Promise.resolve()
  const socket = FakeSocket.all[0]!
  socket.accept()
  expect(subscribes(socket).at(-1)!.types).toBeUndefined()
  socket.deliver({ id: 0, type: "message", data: JSON.stringify({ payload: { type: "kind16.x" } }), lastEventId: "1" })
  expect(seen).toEqual(["16:kind16.x"])
  hub.close()
})

test("a widened filter reopens upstream without resyncing listeners that already had their open; hide/show resyncs all", async () => {
  const hub = socketHub()
  let first = 0
  let second = 0
  const a = hub.subscribe("/oc/global/event", { types: ["session."] })
  a.onopen = () => first++
  await Promise.resolve()
  const socket = FakeSocket.all[0]!
  socket.accept()
  socket.deliver({ id: 0, type: "open" })
  const b = hub.subscribe("/oc/global/event", { types: ["message."] })
  b.onopen = () => second++
  await Promise.resolve()
  // The server answers the widened subscribe with a fresh open.
  socket.deliver({ id: 0, type: "open" })
  expect([first, second]).toEqual([1, 1])
  hub.pause()
  socket.finishClose()
  hub.resume()
  const next = FakeSocket.all.at(-1)!
  next.accept()
  next.deliver({ id: 0, type: "open" })
  expect([first, second]).toEqual([2, 2])
  hub.close()
})

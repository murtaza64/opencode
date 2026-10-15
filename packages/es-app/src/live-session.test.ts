import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { createLiveSession, TAIL } from "./live-session"

const failure = "Cannot connect to API: Unable to connect. Is the computer able to access the url?"
const modelError = { name: "UnknownError", data: { message: failure } }
const assistant = (id = "msg_002", error: unknown = modelError) => ({
  id,
  sessionID: "ses_current",
  role: "assistant",
  parentID: "msg_001",
  time: { created: 2 },
  error,
})
const user = (id = "msg_001") => ({ id, sessionID: "ses_current", role: "user", time: { created: 1 } })
const text = (value: string) => ({
  id: "prt_001",
  sessionID: "ses_current",
  messageID: "msg_002",
  type: "text",
  text: value,
})

class SessionEvents {
  static current: SessionEvents
  onmessage?: (event: { data: string }) => void
  onopen?: () => void
  onerror?: () => void
  closed = false
  constructor(readonly url: string) {
    SessionEvents.current = this
  }
  close() {
    this.closed = true
  }
  send(type: string, properties: unknown = {}) {
    this.onmessage?.({ data: JSON.stringify({ type, properties }) })
  }
}

let dispose: () => void
let fetchSpy: Mock<(input: RequestInfo | URL) => Promise<Response>>
let originalSource: PropertyDescriptor | undefined
let snapshot: { info: unknown; parts: unknown[] }[]
let statuses: Record<string, unknown>
let todos: unknown[]

const response = (input: string | URL | Request) => {
  const path = String(input).split("?")[0]
  if (path === "/oc/session/ses_current/message") {
    const query = new URL(String(input), "http://fixture").searchParams
    const before = query.get("before")
    const eligible = before ? snapshot.filter((message) => (message.info as { id: string }).id < before) : snapshot
    const items = query.has("limit") ? eligible.slice(-Number(query.get("limit"))) : eligible
    return Response.json(items, {
      headers: eligible.length > items.length ? { "X-Next-Cursor": (items[0]?.info as { id: string }).id } : {},
    })
  }
  if (path === "/oc/session/status") return Response.json(statuses)
  if (path === "/oc/session/ses_current/todo") return Response.json(todos)
  if (path === "/oc/session/ses_current") return Response.json({ id: "ses_current", title: "Test" })
  throw new Error(`Unexpected fetch: ${path}`)
}
const start = (onEvent?: Parameters<typeof createLiveSession>[2]) =>
  createRoot((cleanup) => {
    dispose = cleanup
    return createLiveSession("ses_current", "/repo", onEvent)
  })
const busy = () => SessionEvents.current.send("session.status", { sessionID: "ses_current", status: { type: "busy" } })
const fail = () => SessionEvents.current.send("session.error", { sessionID: "ses_current", error: modelError })

beforeEach(() => {
  snapshot = []
  statuses = {}
  todos = []
  originalSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource")
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: SessionEvents })
  fetchSpy = spyOn(globalThis, "fetch")
  fetchSpy.mockImplementation(async (input) => response(input))
})

afterEach(() => {
  dispose?.()
  fetchSpy.mockRestore()
  if (originalSource) Object.defineProperty(globalThis, "EventSource", originalSource)
  else Reflect.deleteProperty(globalThis, "EventSource")
})

test("model connection failure stops thinking without waiting for an idle event", async () => {
  const live = start()
  await live.load()
  busy()
  fail()
  expect(live.data.session_status.ses_current.type).toBe("idle")
  expect(live.error()).toBe(failure)
  expect(live.connectionError()).toBe("")
})

test("todos load with the snapshot and follow todo.updated for this session only", async () => {
  todos = [{ content: "first", status: "in_progress", priority: "high" }]
  const live = start()
  await live.load()
  expect(live.data.todo).toEqual([{ content: "first", status: "in_progress", priority: "high" }])
  SessionEvents.current.send("todo.updated", { sessionID: "ses_other", todos: [] })
  expect(live.data.todo).toHaveLength(1)
  SessionEvents.current.send("todo.updated", { sessionID: "ses_current", todos: [{ content: "first", status: "completed", priority: "high" }] })
  expect(live.data.todo[0]?.status).toBe("completed")
})

test("a failed todo read keeps the transcript snapshot and the last list", async () => {
  todos = [{ content: "kept", status: "pending", priority: "low" }]
  snapshot = [{ info: user(), parts: [] }]
  const live = start()
  await live.load()
  fetchSpy.mockImplementation(async (input) =>
    String(input).includes("/todo?") ? Response.json({ error: "nope" }, { status: 500 }) : response(input))
  snapshot = [{ info: user(), parts: [] }, { info: assistant("msg_002", undefined), parts: [] }]
  await live.load()
  expect(live.data.message.ses_current).toHaveLength(2)
  expect(live.data.todo).toEqual([{ content: "kept", status: "pending", priority: "low" }])
  expect(live.connectionError()).toBe("")
})

test("initial snapshot requests 80 messages and retains the older-page cursor", async () => {
  snapshot = Array.from({ length: 162 }, (_, index) => ({ info: user(`msg_${String(index).padStart(3, "0")}`), parts: [] }))
  const live = start()
  await live.load()
  expect(TAIL).toBe(80)
  expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/message?"))).toHaveLength(1)
  expect(new URL(String(fetchSpy.mock.calls.find(([input]) => String(input).includes("/message?"))![0]), "http://fixture").searchParams.get("limit")).toBe("80")
  expect(live.data.message.ses_current?.[0]?.id).toBe("msg_082")
  expect(live.hasOlder()).toBe(true)
})

test("older pages prepend in order without duplicates and stop at the first message", async () => {
  snapshot = Array.from({ length: 162 }, (_, index) => ({ info: user(`msg_${String(index).padStart(3, "0")}`), parts: [] }))
  const live = start()
  await live.load()
  SessionEvents.current.send("message.updated", { info: user("msg_090") })
  await live.older()
  expect(live.data.message.ses_current).toHaveLength(160)
  expect(live.data.message.ses_current?.[0]?.id).toBe("msg_002")
  expect(live.hasOlder()).toBe(true)
  await live.older()
  expect(live.data.message.ses_current?.map((message) => message.id)).toEqual(
    snapshot.map((message) => (message.info as { id: string }).id),
  )
  expect(live.hasOlder()).toBe(false)
  expect(live.loadingOlder()).toBe(false)
  expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/message?"))).toHaveLength(3)
})

test("older SSE updates do not open gaps until older history is loaded", async () => {
  snapshot = Array.from({ length: 81 }, (_, index) => ({ info: user(`msg_${String(index).padStart(3, "0")}`), parts: [] }))
  const live = start()
  await live.load()
  SessionEvents.current.send("message.updated", { info: user("msg_000") })
  expect(live.data.message.ses_current?.[0]?.id).toBe("msg_001")
  await live.older()
  expect(live.hasOlder()).toBe(false)
  SessionEvents.current.send("message.updated", { info: user("msg_000") })
  expect(live.data.message.ses_current?.[0]?.id).toBe("msg_000")
})

test("refresh retains older pages and their cursor while updating the new tail", async () => {
  snapshot = Array.from({ length: 162 }, (_, index) => ({ info: user(`msg_${String(index).padStart(3, "0")}`), parts: [] }))
  const live = start()
  await live.load()
  await live.older()
  snapshot.push({ info: user("msg_162"), parts: [] })
  await live.load()
  expect(live.data.message.ses_current).toHaveLength(161)
  expect(live.data.message.ses_current?.[0]?.id).toBe("msg_002")
  expect(live.data.message.ses_current?.at(-1)?.id).toBe("msg_162")
  expect(live.hasOlder()).toBe(true)
  await live.older()
  expect(live.data.message.ses_current).toHaveLength(163)
  expect(live.hasOlder()).toBe(false)
})

test("refresh clears an old cursor when its complete tail reaches the first message", async () => {
  snapshot = Array.from({ length: 81 }, (_, index) => ({ info: user(`msg_${String(index).padStart(3, "0")}`), parts: [] }))
  const live = start()
  await live.load()
  expect(live.hasOlder()).toBe(true)
  snapshot = snapshot.slice(1)
  await live.load()
  expect(live.data.message.ses_current?.[0]?.id).toBe("msg_001")
  expect(live.hasOlder()).toBe(false)
})

test("snapshot and live updates retain summary metadata without unused patch bodies", async () => {
  const summary = {
    title: "Changes",
    diffs: [{ file: "fixture.ts", patch: "+large fixture patch", additions: 1, deletions: 0, status: "modified" }],
  }
  snapshot = [{ info: { ...user(), summary }, parts: [{ ...text("visible text"), messageID: "msg_001" }] }]
  const live = start()
  await live.load()
  expect(JSON.parse(JSON.stringify(live.data.message.ses_current?.[0]))).toMatchObject({
    summary: { title: "Changes", diffs: [{ file: "fixture.ts", additions: 1, deletions: 0, status: "modified" }] },
  })
  expect(JSON.stringify(live.data.message.ses_current)).not.toContain("large fixture patch")
  expect(live.data.part.msg_001?.[0]).toMatchObject({ text: "visible text" })
  expect(summary.diffs[0]?.patch).toBe("+large fixture patch")
  SessionEvents.current.send("message.updated", {
    info: { ...user(), summary: { diffs: [{ ...summary.diffs[0], patch: "+updated patch", additions: 2 }] } },
  })
  expect(JSON.stringify(live.data.message.ses_current)).not.toContain("updated patch")
  expect(JSON.parse(JSON.stringify(live.data.message.ses_current?.[0]))).toMatchObject({
    summary: { diffs: [{ additions: 2 }] },
  })
  SessionEvents.current.send("message.updated", { info: { ...assistant("msg_002", null), summary: true } })
  expect(live.data.message.ses_current?.[1]).toMatchObject({ role: "assistant", summary: true })
})

test("persisted assistant failure overrides stale busy and survives idle and reload", async () => {
  snapshot = [
    { info: user(), parts: [] },
    { info: assistant(), parts: [] },
  ]
  statuses = { ses_current: { type: "busy" } }
  const live = start()
  await live.load()
  expect(live.data.session_status.ses_current.type).toBe("idle")
  expect(live.error()).toBe(failure)
  SessionEvents.current.send("session.idle", { sessionID: "ses_current" })
  await live.load()
  expect(live.error()).toBe(failure)
})

test("new running status clears failures without resurrecting the same persisted error", async () => {
  snapshot = [{ info: assistant(), parts: [] }]
  const live = start()
  await live.load()
  busy()
  expect(live.error()).toBe("")
  await live.load()
  expect(live.error()).toBe("")
  SessionEvents.current.send("message.updated", { info: assistant() })
  expect(live.error()).toBe("")
  SessionEvents.current.send("message.updated", { info: assistant("msg_004") })
  expect(live.error()).toBe(failure)
})

test("only a newer attempt clears the latest persisted assistant failure", async () => {
  snapshot = [
    { info: user(), parts: [] },
    { info: assistant(), parts: [] },
  ]
  const live = start()
  await live.load()
  SessionEvents.current.send("message.updated", { info: user() })
  expect(live.error()).toBe(failure)
  SessionEvents.current.send("message.updated", { info: user("msg_003") })
  expect(live.error()).toBe("")
  SessionEvents.current.send("message.updated", { info: assistant() })
  expect(live.error()).toBe("")
})

test("historical assistant failures do not override a newer successful attempt", async () => {
  snapshot = [
    { info: assistant(), parts: [] },
    { info: user("msg_003"), parts: [] },
    { info: assistant("msg_004", null), parts: [] },
  ]
  const live = start()
  await live.load()
  expect(live.error()).toBe("")
})

test("retry exposes metadata, clears terminal failure, and idle removes retry metadata", async () => {
  const live = start()
  await live.load()
  fail()
  const retry = { type: "retry" as const, attempt: 2, message: "Rate limited", next: 12345 }
  SessionEvents.current.send("session.status", { sessionID: "ses_current", status: retry })
  expect(live.error()).toBe("")
  expect(live.retry()).toEqual(retry)
  SessionEvents.current.send("session.idle", { sessionID: "ses_current" })
  expect(live.data.session_status.ses_current.type).toBe("idle")
  expect(live.retry()).toBeUndefined()
})

test("snapshot failures are visible, reject explicit loads, and stop stale busy", async () => {
  const live = start()
  busy()
  fetchSpy.mockRejectedValue(new Error("snapshot offline"))
  const loading = live.load()
  expect(live.loading()).toBe(true)
  await expect(loading).rejects.toThrow("snapshot offline")
  expect(live.connectionError()).toContain("snapshot offline")
  expect(live.loading()).toBe(false)
  expect(live.data.session_status.ses_current.type).toBe("idle")
  fetchSpy.mockImplementation(async (input) => response(input))
  await live.load()
  expect(live.connectionError()).toBe("")
})

test("a transient snapshot failure recovers without a stream reconnect or page reload", async () => {
  snapshot = [{ info: user(), parts: [] }]
  const live = start()
  fetchSpy.mockImplementationOnce(async () => { throw new Error("temporary socket failure") })
  await expect(live.load()).rejects.toThrow("temporary socket failure")
  expect(live.connectionError()).toContain("temporary socket failure")
  const recovered = Promise.withResolvers<void>()
  const cleanup = createRoot((cleanup) => {
    createComputed(() => {
      if (live.data.message.ses_current?.length === 1 && !live.connectionError()) recovered.resolve()
    })
    return cleanup
  })
  try {
    await recovered.promise
    expect(fetchSpy.mock.calls).toHaveLength(8)
    expect(fetchSpy.mock.calls.every(([input]) => !String(input).includes("prompt"))).toBe(true)
  } finally {
    cleanup()
  }
})

test("disposing a failed session stops its scheduled snapshot retry", async () => {
  const live = start()
  fetchSpy.mockRejectedValue(new Error("temporary socket failure"))
  await expect(live.load()).rejects.toThrow("temporary socket failure")
  dispose()
  await Bun.sleep(1100)
  expect(fetchSpy.mock.calls).toHaveLength(4)
})

test("disconnect stops stale busy and reconnect resnapshots missed messages and status", async () => {
  const live = start()
  await live.load()
  SessionEvents.current.onopen?.()
  await live.load()
  busy()
  SessionEvents.current.onerror?.()
  expect(live.connectionError()).not.toBe("")
  expect(live.data.session_status.ses_current.type).toBe("idle")
  snapshot = [
    { info: user(), parts: [] },
    { info: assistant(), parts: [text("Recovered")] },
  ]
  SessionEvents.current.onopen?.()
  expect(live.loading()).toBe(true)
  await live.load()
  expect(live.data.message.ses_current).toHaveLength(2)
  expect(live.data.part.msg_002?.[0]).toMatchObject({ text: "Recovered" })
  expect(live.error()).toBe(failure)
  expect(live.connectionError()).toBe("")
  expect(fetchSpy.mock.calls.every(([input]) => !String(input).includes("prompt"))).toBe(true)
})

test("refresh retains existing message and part identities while applying authoritative changes", async () => {
  snapshot = [
    { info: user(), parts: [] },
    { info: assistant("msg_002", null), parts: [text("Before refresh")] },
    { info: user("msg_003"), parts: [] },
  ]
  const live = start()
  await live.load()
  const message = live.data.message.ses_current![1]
  const part = live.data.part.msg_002![0]
  snapshot = [
    { info: user(), parts: [] },
    { info: { ...assistant("msg_002", null), time: { created: 2, completed: 3 } }, parts: [text("After refresh")] },
  ]
  await live.load()
  expect(live.data.message.ses_current?.map((m) => m.id)).toEqual(["msg_001", "msg_002"])
  expect(live.data.message.ses_current![1]).toBe(message)
  expect(live.data.part.msg_002![0]).toBe(part)
  expect(message?.time).toEqual({ created: 2, completed: 3 })
  expect(part).toMatchObject({ text: "After refresh" })
  expect(live.data.part.msg_003).toBeUndefined()
})

test("refresh removes missing parts and preserves surviving parts through reordering", async () => {
  snapshot = [{ info: assistant("msg_002", null), parts: [text("Removed"), { ...text("Retained"), id: "prt_002" }] }]
  const live = start()
  await live.load()
  const retained = live.data.part.msg_002![1]
  snapshot = [
    {
      info: assistant("msg_002", null),
      parts: [
        { ...text("Updated"), id: "prt_002" },
        { ...text("Added"), id: "prt_003" },
      ],
    },
  ]
  await live.load()
  expect(live.data.part.msg_002?.map((p) => p.id)).toEqual(["prt_002", "prt_003"])
  expect(live.data.part.msg_002![0]).toBe(retained)
  expect(retained).toMatchObject({ text: "Updated" })
})

test("events during snapshot loading cannot be overwritten by an older snapshot", async () => {
  const live = start()
  await live.load()
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    const stale = response(input)
    await gate.promise
    return stale
  })
  const loading = live.load()
  SessionEvents.current.send("message.updated", { info: user("msg_003") })
  busy()
  fail()
  snapshot = [{ info: user("msg_003"), parts: [] }]
  fetchSpy.mockImplementation(async (input) => response(input))
  gate.resolve()
  await loading
  expect(live.data.message.ses_current?.map((m) => m.id)).toEqual(["msg_003"])
  expect(live.error()).toBe(failure)
  expect(live.data.session_status.ses_current.type).toBe("idle")
})

test("a snapshot that already contains a concurrent delta does not duplicate text", async () => {
  snapshot = [{ info: assistant("msg_002", null), parts: [text("a")] }]
  const live = start()
  await live.load()
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    await gate.promise
    return response(input)
  })
  const loading = live.load()
  SessionEvents.current.send("message.part.delta", {
    sessionID: "ses_current",
    messageID: "msg_002",
    partID: "prt_001",
    field: "text",
    delta: "b",
  })
  snapshot = [{ info: assistant("msg_002", null), parts: [text("ab")] }]
  gate.resolve()
  await loading
  expect(live.data.part.msg_002?.[0]).toMatchObject({ text: "ab" })
  expect(live.data.part_text_accum_delta.prt_001).toBeUndefined()
})

test("other sessions cannot clear or set this session's failure or execution status", async () => {
  const live = start()
  await live.load()
  fail()
  SessionEvents.current.send("session.status", { sessionID: "ses_child", status: { type: "busy" } })
  SessionEvents.current.send("session.error", { sessionID: "ses_child", error: { message: "child failure" } })
  expect(live.error()).toBe(failure)
  expect(live.data.session_status.ses_current.type).toBe("idle")
})

test("callback receives each event once and asynchronous callback failures are visible", async () => {
  const seen: string[] = []
  const live = start(async (event) => {
    seen.push(event.type)
    throw new Error("callback failed")
  })
  await live.load()
  fail()
  await Promise.resolve()
  await Promise.resolve()
  expect(seen).toEqual(["session.error"])
  expect(live.error()).toBe(failure)
  expect(live.connectionError()).toContain("callback failed")
})

test("disposing closes SSE and prevents an outstanding snapshot from mutating data", async () => {
  const live = start()
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    await gate.promise
    return response(input)
  })
  const loading = live.load()
  dispose()
  gate.resolve()
  await loading
  expect(SessionEvents.current.closed).toBe(true)
  expect(live.data.session).toEqual([])
})

test("a late assistant update cannot clear a terminal event failure", async () => {
  snapshot = [{ info: user(), parts: [] }]
  const live = start()
  await live.load()
  busy()
  fail()
  SessionEvents.current.send("message.updated", { info: assistant("msg_002", null) })
  expect(live.error()).toBe(failure)
  expect(live.data.session_status.ses_current.type).toBe("idle")
})

test("a reconnect snapshot of the failed attempt does not clear its terminal event failure", async () => {
  snapshot = [{ info: user(), parts: [] }]
  const live = start()
  await live.load()
  fail()
  snapshot = [
    { info: user(), parts: [] },
    { info: assistant("msg_002", null), parts: [] },
  ]
  await live.load()
  expect(live.error()).toBe(failure)
})

test("a newer user attempt recovered by snapshot clears an old terminal event failure", async () => {
  snapshot = [{ info: user(), parts: [] }]
  const live = start()
  await live.load()
  fail()
  snapshot = [
    { info: user("msg_003"), parts: [] },
    { info: assistant("msg_004", null), parts: [] },
  ]
  statuses = { ses_current: { type: "busy" } }
  await live.load()
  expect(live.error()).toBe("")
  expect(live.data.session_status.ses_current.type).toBe("busy")
})

test("initial SSE open recovers messages missed between the first snapshot and subscription", async () => {
  const live = start()
  await live.load()
  snapshot = [{ info: user(), parts: [] }]
  SessionEvents.current.onopen?.()
  expect(live.loading()).toBe(true)
  await live.load()
  expect(live.data.message.ses_current?.map((m) => m.id)).toEqual(["msg_001"])
  expect(fetchSpy).toHaveBeenCalledTimes(8)
})

test("concurrent loads share one snapshot request", async () => {
  const live = start()
  const first = live.load()
  const second = live.load()
  expect(first).toBe(second)
  await first
  expect(fetchSpy).toHaveBeenCalledTimes(4)
})

test("initial stream open during a snapshot does not fetch messages again", async () => {
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    if (String(input).includes("/message?")) await gate.promise
    return response(input)
  })
  const live = start()
  const loading = live.load()
  SessionEvents.current.onopen?.()
  gate.resolve()
  await loading
  await Promise.resolve()
  await Promise.resolve()
  expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/message?"))).toHaveLength(1)
})

test("a lost stream reopening during a snapshot still repairs the missed gap", async () => {
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    if (String(input).includes("/message?")) started.resolve()
    await gate.promise
    return response(input)
  })
  const live = start()
  const loading = live.load()
  SessionEvents.current.onerror?.()
  await started.promise
  snapshot = [{ info: user(), parts: [] }]
  SessionEvents.current.onopen?.()
  gate.resolve()
  await loading
  await live.load()
  expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/message?"))).toHaveLength(2)
  expect(live.data.message.ses_current?.map((message) => message.id)).toEqual(["msg_001"])
})

test("automatic reconnect load failures reach reactive accessors without an explicit caller", async () => {
  const live = start()
  await live.load()
  const observed = Promise.withResolvers<string>()
  const cleanup = createRoot((cleanup) => {
    createComputed(() => {
      if (live.connectionError().includes("HTTP 503")) observed.resolve(live.connectionError())
    })
    return cleanup
  })
  fetchSpy.mockResolvedValue(new Response("Service unavailable", { status: 503 }))
  SessionEvents.current.onopen?.()
  try {
    expect(await observed.promise).toContain("HTTP 503")
    expect(live.loading()).toBe(false)
    expect(live.data.session_status.ses_current.type).toBe("idle")
  } finally {
    cleanup()
  }
})

test("snapshot success cannot hide an ongoing SSE disconnect", async () => {
  const live = start()
  await live.load()
  SessionEvents.current.onerror?.()
  statuses = { ses_current: { type: "busy" } }
  await live.load()
  expect(live.connectionError()).toContain("connection lost")
  expect(live.data.session_status.ses_current.type).toBe("idle")
})

test("malformed frames and synchronous callback failures are surfaced instead of swallowed", async () => {
  const live = start(() => {
    throw new Error("callback failed")
  })
  await live.load()
  SessionEvents.current.onmessage?.({ data: "{" })
  expect(live.connectionError()).toContain("Unable to process session event")
  fail()
  expect(live.error()).toBe(failure)
  expect(live.connectionError()).toContain("callback failed")
})

test("EventSource construction failure leaves a usable store with a visible connection error", async () => {
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: class {
      constructor() {
        throw new Error("SSE unavailable")
      }
    },
  })
  const live = start()
  await live.load()
  expect(live.connectionError()).toContain("SSE unavailable")
  expect(live.data.session_status.ses_current.type).toBe("idle")
})

test("missing error data and foreign error events do not throw or misattribute a failure", async () => {
  const live = start()
  await live.load()
  SessionEvents.current.send("session.error", { error: modelError })
  expect(live.error()).toBe("")
  SessionEvents.current.send("session.error", {
    sessionID: "ses_current",
    error: { name: "MessageOutputLengthError", data: {} },
  })
  expect(live.error()).toBe("MessageOutputLengthError")
  busy()
  SessionEvents.current.send("session.error", { sessionID: "ses_current" })
  expect(live.error()).toBe("Session failed")
})

test("busy cannot suppress an error first reported on the existing assistant message", async () => {
  const live = start()
  await live.load()
  SessionEvents.current.send("message.updated", { info: assistant("msg_002", null) })
  busy()
  const error = { name: "StructuredOutputError", data: { message: "Invalid structured output", retries: 2 } }
  SessionEvents.current.send("message.updated", { info: assistant("msg_002", error) })
  expect(live.error()).toBe("Invalid structured output")
  expect(live.data.session_status.ses_current.type).toBe("idle")
  snapshot = [{ info: assistant("msg_002", error), parts: [] }]
  await live.load()
  expect(live.error()).toBe("Invalid structured output")
  busy()
  expect(live.error()).toBe("")
})

test("initial hydration finishes even when every snapshot races streaming deltas", async () => {
  snapshot = [
    { info: user(), parts: [] },
    { info: assistant("msg_002", null), parts: [text("a")] },
  ]
  statuses = { ses_current: { type: "busy" } }
  const live = start()
  let reads = 0
  fetchSpy.mockImplementation(async (input) => {
    const result = response(input)
    if (String(input).includes("/message?")) {
      if (++reads > 3) throw new Error("Snapshot hydration starved by streaming deltas")
      SessionEvents.current.send("message.part.delta", {
        sessionID: "ses_current",
        messageID: "msg_002",
        partID: "prt_001",
        field: "text",
        delta: "b",
      })
    }
    return result
  })
  await expect(live.load()).resolves.toBeUndefined()
  expect(live.loading()).toBe(false)
  expect(live.data.session[0]?.id).toBe("ses_current")
  expect(live.data.message.ses_current?.map((m) => m.id)).toEqual(["msg_001", "msg_002"])
  expect(live.data.part.msg_002?.[0]).toMatchObject({ type: "text" })
  expect(live.data.session_status.ses_current.type).toBe("busy")
  expect(reads).toBe(1)
})

test("busy cannot suppress a previously unseen failure recovered by a snapshot", async () => {
  snapshot = [{ info: assistant("msg_002", null), parts: [] }]
  const live = start()
  await live.load()
  busy()
  snapshot = [{ info: assistant(), parts: [] }]
  await live.load()
  expect(live.error()).toBe(failure)
  expect(live.data.session_status.ses_current.type).toBe("idle")
})

test("a concurrent full part provides a delta base without replaying callbacks or duplicating text", async () => {
  snapshot = [{ info: assistant("msg_002", null), parts: [text("abc")] }]
  const seen: string[] = []
  const live = start((event) => {
    seen.push(event.type)
  })
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    const result = response(input)
    await gate.promise
    return result
  })
  const loading = live.load()
  SessionEvents.current.send("message.part.updated", { part: text("a") })
  SessionEvents.current.send("message.part.delta", {
    sessionID: "ses_current",
    messageID: "msg_002",
    partID: "prt_001",
    field: "text",
    delta: "b",
  })
  SessionEvents.current.send("message.part.delta", {
    sessionID: "ses_current",
    messageID: "msg_002",
    partID: "prt_001",
    field: "text",
    delta: "c",
  })
  gate.resolve()
  await loading
  expect(live.data.part.msg_002?.[0]).toMatchObject({ text: "abc" })
  expect(seen).toEqual(["message.part.updated", "message.part.delta", "message.part.delta"])
  expect(fetchSpy).toHaveBeenCalledTimes(4)
})

test("ambiguous deltas use the snapshot until idle triggers one authoritative recovery", async () => {
  snapshot = [{ info: assistant("msg_002", null), parts: [text("a")] }]
  statuses = { ses_current: { type: "busy" } }
  const live = start()
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    const result = response(input)
    await gate.promise
    return result
  })
  const loading = live.load()
  SessionEvents.current.send("message.part.delta", {
    sessionID: "ses_current",
    messageID: "msg_002",
    partID: "prt_001",
    field: "text",
    delta: "b",
  })
  gate.resolve()
  await loading
  expect(live.loading()).toBe(false)
  expect(live.data.part.msg_002?.[0]).toMatchObject({ text: "a" })
  expect(fetchSpy).toHaveBeenCalledTimes(4)

  snapshot = [{ info: assistant("msg_002", null), parts: [text("ab")] }]
  statuses = {}
  SessionEvents.current.send("session.idle", { sessionID: "ses_current" })
  expect(live.loading()).toBe(true)
  await live.load()
  expect(live.data.part.msg_002?.[0]).toMatchObject({ text: "ab" })
  expect(live.data.session_status.ses_current.type).toBe("idle")
  expect(fetchSpy).toHaveBeenCalledTimes(8)
  SessionEvents.current.send("session.idle", { sessionID: "ses_current" })
  expect(live.loading()).toBe(false)
  expect(fetchSpy).toHaveBeenCalledTimes(8)
})

test("a full part repairs ambiguous text without another snapshot", async () => {
  snapshot = [{ info: assistant("msg_002", null), parts: [text("a")] }]
  const live = start()
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    await gate.promise
    return response(input)
  })
  const loading = live.load()
  SessionEvents.current.send("message.part.delta", {
    sessionID: "ses_current",
    messageID: "msg_002",
    partID: "prt_001",
    field: "text",
    delta: "b",
  })
  gate.resolve()
  await loading
  SessionEvents.current.send("message.part.updated", { part: text("ab") })
  SessionEvents.current.send("session.status", { sessionID: "ses_current", status: { type: "idle" } })
  expect(live.data.part.msg_002?.[0]).toMatchObject({ text: "ab" })
  expect(live.loading()).toBe(false)
  expect(fetchSpy).toHaveBeenCalledTimes(4)
})

test("SSE opening during a stale snapshot schedules recovery of the subscription gap", async () => {
  const live = start()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    const result = response(input)
    if (String(input).includes("/message?")) started.resolve()
    await gate.promise
    return result
  })
  const loading = live.load()
  SessionEvents.current.onerror?.()
  await started.promise
  snapshot = [{ info: user("msg_003"), parts: [] }]
  SessionEvents.current.onopen?.()
  fetchSpy.mockImplementation(async (input) => response(input))
  gate.resolve()
  await loading
  expect(live.loading()).toBe(true)
  await live.load()
  expect(live.data.message.ses_current?.map((m) => m.id)).toEqual(["msg_003"])
  expect(fetchSpy).toHaveBeenCalledTimes(8)
})

test("terminal errors during an ambiguous load trigger repair without reviving busy status", async () => {
  snapshot = [{ info: assistant("msg_002", null), parts: [text("a")] }]
  const live = start()
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    const result = response(input)
    await gate.promise
    return result
  })
  const loading = live.load()
  SessionEvents.current.send("message.part.delta", {
    sessionID: "ses_current",
    messageID: "msg_002",
    partID: "prt_001",
    field: "text",
    delta: "b",
  })
  busy()
  fail()
  snapshot = [{ info: assistant(), parts: [text("ab")] }]
  statuses = { ses_current: { type: "busy" } }
  fetchSpy.mockImplementation(async (input) => response(input))
  gate.resolve()
  await loading
  expect(live.error()).toBe(failure)
  expect(live.data.session_status.ses_current.type).toBe("idle")
  await live.load()
  expect(live.error()).toBe(failure)
  expect(live.data.part.msg_002?.[0]).toMatchObject({ text: "ab" })
  expect(live.data.session_status.ses_current.type).toBe("idle")
  expect(fetchSpy).toHaveBeenCalledTimes(8)
})

test("concurrent removals and retry metadata survive hydration", async () => {
  snapshot = [
    { info: user(), parts: [] },
    { info: assistant("msg_002", null), parts: [text("old")] },
  ]
  const live = start()
  const gate = Promise.withResolvers<void>()
  fetchSpy.mockImplementation(async (input) => {
    await gate.promise
    return response(input)
  })
  const loading = live.load()
  SessionEvents.current.send("message.part.removed", {
    sessionID: "ses_current",
    messageID: "msg_002",
    partID: "prt_001",
  })
  SessionEvents.current.send("message.removed", { sessionID: "ses_current", messageID: "msg_001" })
  const retry = { type: "retry" as const, attempt: 2, message: "Rate limited", next: 12345 }
  SessionEvents.current.send("session.status", { sessionID: "ses_current", status: retry })
  gate.resolve()
  await loading
  expect(live.data.message.ses_current?.map((m) => m.id)).toEqual(["msg_002"])
  expect(live.data.part.msg_002).toEqual([])
  expect(live.retry()).toEqual(retry)
})

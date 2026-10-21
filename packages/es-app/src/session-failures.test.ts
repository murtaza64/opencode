import { expect, test } from "bun:test"
import type { Event, SessionFailure } from "@opencode-ai/sdk/v2"
import { createRoot } from "solid-js"
import { createSessionFailures, failureLabel, retryLabel, type RetryResult } from "./session-failures"
import { unresolvedSend } from "./composer"

const failure = (sessionID: string, messageID = `msg_${sessionID}`, retry: SessionFailure["retry"] = "available"): SessionFailure => ({
  sessionID,
  directory: "/repo",
  messageID,
  parentID: "msg_user",
  time: 1,
  error: { name: "APIError", statusCode: 403 },
  retry,
})
const status = (sessionID: string, type: "busy" | "idle") =>
  ({ type: "session.status", properties: { sessionID, status: { type } } }) as Event
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const setup = (deps: Parameters<typeof createSessionFailures>[0]) =>
  createRoot((dispose) => {
    const store = createSessionFailures({ blocked: () => "", ...deps })
    return { store, dispose: () => { store.dispose(); dispose() } }
  })

test("labels never include provider text", () => {
  expect(failureLabel(failure("a"))).toBe("Provider error 403 (forbidden)")
  expect(failureLabel({ error: { name: "APIError" } })).toBe("Provider error")
  expect(failureLabel({ error: { name: "SomethingNew" } })).toBe("Turn failed")
  expect(retryLabel({ outcome: "unknown", detail: "The response was lost" })).toContain("still shown as failed")
  expect(retryLabel({ outcome: "unsafe", failed: failure("a", "msg_a", "out-of-order") })).toBe("Not retried: the failed step is timestamped in the future")
  expect(retryLabel({ outcome: "unsafe", failed: failure("a", "msg_a", "unsafe") })).toBe("Not retried: the failed step ran tools")
})

test("an old Core without the endpoint hides the feature instead of reporting no failures", async () => {
  const { store, dispose } = setup({ list: async () => undefined })
  await store.refresh()
  expect(store.supported()).toBe(false)
  expect(store.items()).toEqual([])
  dispose()
})

test("a failed read keeps last-known failures and reports the outage", async () => {
  let fail = false
  const { store, dispose } = setup({ list: async () => { if (fail) throw new Error("offline"); return [failure("a")] } })
  await store.refresh()
  fail = true
  await store.refresh()
  expect(store.failure("a")?.messageID).toBe("msg_a")
  expect(store.error()).toContain("unavailable")
  dispose()
})

test("a first read that fails reports the outage instead of looking healthy", async () => {
  const { store, dispose } = setup({ list: async () => { throw new Error("HTTP 503") } })
  await store.refresh()
  expect(store.items()).toEqual([])
  expect(store.error()).toBe("Failed-session status unavailable.")
  dispose()
})

test("busy status hides a failure until the durable list confirms what happened next", async () => {
  let next = [failure("a")]
  const { store, dispose } = setup({ list: async () => next })
  await store.refresh()
  store.observe(status("a", "busy"))
  expect(store.failure("a")).toBeUndefined()
  // Still listed with the same identity after a read means the busy work has not replaced it yet.
  next = [failure("a"), failure("b")]
  await store.refresh()
  expect(store.failure("b")).toBeDefined()
  next = [failure("a", "msg_a2")]
  await store.refresh()
  expect(store.failure("a")?.messageID).toBe("msg_a2")
  dispose()
})

test("a retry that goes idle without writing a newer row shows the same failure again", async () => {
  const { store, dispose } = setup({ list: async () => [failure("a")], send: async () => ({ outcome: "accepted" }) })
  await store.refresh()
  await store.retry(store.failure("a")!)
  store.observe(status("a", "busy"))
  await store.refresh()
  expect(store.failure("a")).toBeUndefined()
  store.observe(status("a", "idle"))
  await store.refresh()
  expect(store.failure("a")?.messageID).toBe("msg_a")
  dispose()
})

test("an accepted retry whose idle event beat the response is not kept hidden", async () => {
  const reply = deferred<RetryResult>()
  const { store, dispose } = setup({ list: async () => [failure("a")], send: () => reply.promise })
  await store.refresh()
  const pending = store.retry(store.failure("a")!)
  store.observe(status("a", "busy"))
  store.observe(status("a", "idle"))
  reply.resolve({ outcome: "accepted" })
  await pending
  expect(store.failure("a")).toBeUndefined()
  await store.refresh()
  expect(store.failure("a")?.messageID).toBe("msg_a")
  dispose()
})

test("a status event that arrives during a read wins over that read", async () => {
  const read = deferred<SessionFailure[]>()
  const { store, dispose } = setup({ list: () => read.promise })
  const pending = store.refresh()
  store.observe(status("a", "idle"))
  read.resolve([failure("a")])
  await pending
  expect(store.failure("a")).toBeUndefined()
  dispose()
})

test("double-clicked Retry sends one request and an unknown outcome keeps the session failed", async () => {
  const sent: string[] = []
  const reply = deferred<RetryResult>()
  const { store, dispose } = setup({
    list: async () => [failure("a")],
    send: (item) => { sent.push(item.messageID); return reply.promise },
  })
  await store.refresh()
  const first = store.retry(store.failure("a")!)
  const second = store.retry(store.failure("a")!)
  expect(await second).toBeUndefined()
  expect(store.retryState("a")?.phase).toBe("sending")
  reply.resolve({ outcome: "unknown", detail: "The response was lost" })
  await first
  expect(sent).toEqual(["msg_a"])
  expect(store.failure("a")).toBeDefined()
  expect(store.retryState("a")).toMatchObject({ phase: "done", result: { outcome: "unknown" } })
  dispose()
})

test("Resume all retries only retryable failures with bounded concurrency and reports each outcome", async () => {
  let active = 0
  let peak = 0
  const gates = new Map<string, ReturnType<typeof deferred<RetryResult>>>()
  const items = [failure("a"), failure("b"), failure("c"), failure("d"), failure("e", "msg_e", "unsafe"), failure("f", "msg_f", "out-of-order")]
  const { store, dispose } = setup({
    list: async () => items,
    send: async (item) => {
      active++
      peak = Math.max(peak, active)
      const gate = deferred<RetryResult>()
      gates.set(item.sessionID, gate)
      const result = await gate.promise
      active--
      return result
    },
  })
  await store.refresh()
  const run = store.retryAll(store.items())
  await Promise.resolve()
  expect([...gates.keys()]).toEqual(["a", "b", "c"])
  gates.get("a")!.resolve({ outcome: "accepted" })
  gates.get("b")!.resolve({ outcome: "stale", failed: failure("b", "msg_b2") })
  await new Promise((done) => setTimeout(done, 0))
  gates.get("c")!.resolve({ outcome: "unknown", detail: "HTTP 502" })
  await new Promise((done) => setTimeout(done, 0))
  gates.get("d")!.resolve({ outcome: "running" })
  const results = await run
  expect(peak).toBeLessThanOrEqual(3)
  expect(results.map((row) => [row.failure.sessionID, row.result?.outcome])).toEqual([
    ["a", "accepted"], ["b", "stale"], ["c", "unknown"], ["d", "running"],
  ])
  expect(gates.has("e")).toBe(false)
  expect(gates.has("f")).toBe(false)
  expect(store.failure("a")).toBeUndefined()
  expect(store.failure("c")).toBeDefined()
  expect(store.failure("d")).toBeUndefined()
  dispose()
})

test("Retry waits while a human send to that session is unresolved", async () => {
  const sent: string[] = []
  const { store, dispose } = setup({
    list: async () => [failure("a"), failure("b")],
    send: async (item) => { sent.push(item.sessionID); return { outcome: "accepted" } },
    blocked: (item) => item.sessionID === "a" ? "A previous Send outcome is unknown. Check the conversation first." : "",
  })
  await store.refresh()
  const results = await store.retryAll(store.items())
  expect(sent).toEqual(["b"])
  expect(results.find((row) => row.failure.sessionID === "a")?.result).toMatchObject({ outcome: "blocked" })
  expect(store.failure("a")).toBeDefined()
  dispose()
})

test("an unknown normal Send or unresolved admission saved for a session blocks its Retry", () => {
  const store = (record: unknown) => () => ({ getItem: () => JSON.stringify(record) })
  expect(unresolvedSend("ses_x", "/repo", store({ normalSubmission: { status: "unknown", text: "t", images: 0 } }))).toContain("unknown")
  expect(unresolvedSend("ses_x", "/repo", store({ admission: { status: "unknown" } }))).toContain("admission")
  expect(unresolvedSend("ses_x", "/repo", store({ normalSubmission: { status: "accepted", text: "t", images: 0 } }))).toBe("")
})

test("a session with no saved composer state can be retried", () => {
  expect(unresolvedSend("ses_x", "/repo", () => ({ getItem: () => null }))).toBe("")
  expect(unresolvedSend("ses_x", "/repo", () => null)).toBe("")
})

test("unreadable saved composer state blocks Retry instead of reading as no pending send", () => {
  expect(unresolvedSend("ses_x", "/repo", () => ({ getItem: () => "{broken" }))).toContain("unreadable")
  expect(unresolvedSend("ses_x", "/repo", () => ({ getItem: () => "null" }))).toContain("unreadable")
  expect(unresolvedSend("ses_x", "/repo", () => ({ getItem: () => { throw new Error("SecurityError") } }))).toContain("unreadable")
  expect(unresolvedSend("ses_x", "/repo", () => { throw new Error("storage disabled") })).toContain("unreadable")
})

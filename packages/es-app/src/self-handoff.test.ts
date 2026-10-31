import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSelfHandoff, selfHandoffText } from "./self-handoff"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

type Call = { method: string; path: string; body?: any; headers?: Record<string, string> }
const harness = (reply: (call: Call) => Response, storage = new MemoryStorage()) => {
  const calls: Call[] = []
  let ids = 0
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", path: url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> }
    calls.push(call)
    return reply(call)
  }) as typeof globalThis.fetch
  const handoff = createRoot(() => createSelfHandoff({ editspace: () => "opencode", lane: () => "lane-a", session: "ses_a", storage, fetch, mint: () => `sh_${++ids}`, poll: 60_000 }))
  return { handoff, calls, storage }
}
const json = (body: unknown, status = 200) => Response.json(body, { status })

describe("self-handoff", () => {
  test("a request is posted once with CSRF headers, and its state comes from the reply", async () => {
    const { handoff, calls } = harness(() => json({ requestID: "sh_1", state: "requested" }, 202))
    await handoff.start()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: "POST", path: "/es/api/handoffs/self?es=opencode", body: { lane: "lane-a", session: "ses_a", requestID: "sh_1" } })
    expect(calls[0]!.headers).toMatchObject({ "X-Attention-CSRF": "1", "content-type": "application/json" })
    expect(handoff.state()).toEqual({ state: "requested" })
  })

  test("a retry after a lost reply re-sends the same request ID", async () => {
    let first = true
    const { handoff, calls } = harness(() => { if (first) { first = false; throw new Error("network") } return json({ state: "requested" }, 202) })
    await handoff.start()
    expect(handoff.state()).toEqual({ state: "error", message: "Could not reach this host's dashboard." })
    await handoff.start()
    expect(calls.map((call) => call.body.requestID)).toEqual(["sh_1", "sh_1"])
  })

  test("a reload resumes the saved request from GET instead of posting again", async () => {
    const storage = new MemoryStorage()
    storage.setItem("es-app:self-handoff:opencode:ses_a", JSON.stringify({ requestID: "sh_9", frontier: false }))
    const { handoff, calls } = harness(() => json({ state: "doc-written" }), storage)
    await handoff.refresh()
    expect(calls).toEqual([expect.objectContaining({ method: "GET", path: "/es/api/handoffs/self/sh_9?es=opencode&lane=lane-a" })])
    expect(handoff.state()).toEqual({ state: "doc-written" })
  })

  test("a frontier model asks for confirmation, then re-sends the same ID with frontier set", async () => {
    const { handoff, calls } = harness((call) => call.body?.frontier ? json({ state: "requested" }, 202) : json({ error: "frontier-confirm", model: "anthropic/fable" }, 409))
    await handoff.start()
    expect(handoff.state()).toEqual({ state: "confirm", model: "anthropic/fable" })
    expect(selfHandoffText(handoff.state())).toContain("anthropic/fable")
    await handoff.start(true)
    expect(calls.map((call) => [call.body.requestID, call.body.frontier])).toEqual([["sh_1", undefined], ["sh_1", true]])
    expect(handoff.state()).toEqual({ state: "requested" })
  })

  test("an already open request elsewhere is adopted and followed", async () => {
    const { handoff, calls } = harness((call) => call.method === "POST" ? json({ error: "conflict", existing: "sh_other" }, 409) : json({ state: "presented" }))
    await handoff.start()
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/es/api/handoffs/self/sh_other?es=opencode&lane=lane-a" })
    expect(handoff.state()).toEqual({ state: "presented" })
  })

  test("verified shows the successor and every field that was not carried over", async () => {
    const { handoff } = harness(() => json({ state: "verified", successor: "ses_b", doc: "handoffs/self-x-handoff.md", title: "T", agent: "build", model: "p/m", notCarried: ["model variant (reasoning effort)"] }))
    await handoff.start()
    expect(handoff.state()).toMatchObject({ state: "verified", successor: "ses_b", notCarried: ["model variant (reasoning effort)"] })
  })

  test("cancel deletes while pending; too late is said plainly; a failure clears for a new request", async () => {
    let late = false
    const { handoff, calls, storage } = harness((call) => call.method === "DELETE" ? (late ? json({ error: "conflict" }, 409) : json({ state: "failed", reason: "cancelled" }))
      : json({ state: "requested" }, 202))
    await handoff.start()
    await handoff.cancel()
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/es/api/handoffs/self/sh_1?es=opencode&lane=lane-a" })
    expect(handoff.state()).toEqual({ state: "failed", reason: "cancelled" })
    late = true
    await handoff.cancel()
    expect(handoff.state()).toEqual({ state: "error", message: "Too late to cancel: the agent already has the request." })
    handoff.reset()
    expect(storage.values.size).toBe(0)
    await handoff.start()
    expect(calls.at(-1)!.body.requestID).toBe("sh_2")
  })

  test("without operator authority the reply says how to get it", async () => {
    const { handoff } = harness(() => json({ error: "operator UI cookie required" }, 403))
    await handoff.start()
    expect(handoff.state()).toEqual({ state: "error", message: "Answers are off: reconnect as operator in Decisions & inbox, then retry." })
  })
})

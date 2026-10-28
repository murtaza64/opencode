import { expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type { ContextPart } from "./api"
import { createComposer } from "./composer"
import { createImageStore } from "./image-store"

const session = { id: "ses_context", agent: "build" } as Session
const directory = "/repo"
const storageKey = `es-app:composer:1:${JSON.stringify([session.id, directory])}`
const baseInput = { version: 1, delivery: ["queue", "steer"], list: true, cancel: true }
const withContext = { sessionAside: { version: 1, cancel: true }, sessionInput: { ...baseInput, context: true } }
const withoutContext = { sessionAside: { version: 1, cancel: true }, sessionInput: baseInput }
const chip = (key: string, text = `contents of ${key}`): ContextPart =>
  ({ type: "text", text, synthetic: true, metadata: { source: "file", key } })
const pendingReceipt = (requestID: string, text: string, delivery: "queue" | "steer") =>
  ({ requestID, text, delivery, sessionID: session.id, agent: "build", admittedSeq: 1, timeCreated: 1, state: "pending" })

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
}
type Seen = { method: string; path: string; body: any }

const harness = (capabilities: unknown, post: (body: any) => Response | Promise<Response>, storage = new MemoryStorage()) => {
  const seen: Seen[] = []
  let sequence = 0
  const dependencies = {
    storage,
    images: createImageStore(),
    requestID: () => `request-${++sequence}`,
    prompt: async () => { throw new Error("Unexpected plain send") },
    fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://composer.test").pathname
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      seen.push({ method: init?.method ?? "GET", path, body })
      if (path === "/oc/experimental/capabilities") return Response.json(capabilities)
      if (init?.method === "POST" && path.endsWith("/input")) return post(body)
      return new Response("not found", { status: 404 })
    },
  }
  return { composer: createComposer(session.id, directory, dependencies), seen, storage, dependencies }
}
const posts = (seen: Seen[]) => seen.filter((item) => item.method === "POST")

test("a busy steer sends selected context in Core's wire shape when Core advertises sessionInput.context", async () => {
  const { composer, seen } = harness(withContext, (body) => Response.json(pendingReceipt(body.requestID, body.text, "steer")))
  await composer.loadCapabilities()
  composer.observeBusy(true)
  expect(composer.contextAttaches("steer")).toBe(true)
  composer.setText("look at these")
  await composer.submitVisible("steer", session, null, undefined, [chip("a.ts"), chip("b.ts")])
  expect(posts(seen).map((item) => item.body.context)).toEqual([[
    { text: "contents of a.ts", source: "file", key: "a.ts" },
    { text: "contents of b.ts", source: "file", key: "b.ts" },
  ]])
})

test("two queued inputs each keep their own context", async () => {
  const { composer, seen } = harness(withContext, (body) => Response.json(pendingReceipt(body.requestID, body.text, "queue")))
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("first")
  await composer.submitVisible("queue", session, null, undefined, [chip("one.ts")])
  composer.setText("second")
  await composer.submitVisible("queue", session, null, undefined, [chip("two.ts")])
  expect(posts(seen).map((item) => [item.body.text, item.body.context.map((part: any) => part.key)])).toEqual([
    ["first", ["one.ts"]],
    ["second", ["two.ts"]],
  ])
})

test("without the capability, a busy steer with chips is blocked with a reason and sends nothing", async () => {
  const { composer, seen } = harness(withoutContext, () => { throw new Error("must not post") })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("look at this")
  expect(composer.contextAttaches("queue")).toBe(false)
  expect(composer.reasonForAction("queue", [chip("a.ts")])).toContain("does not attach @context")
  await composer.submitVisible("queue", session, null, undefined, [chip("a.ts")])
  expect(posts(seen)).toEqual([])
  expect(composer.state.error).toContain("does not attach @context")
  expect(composer.state.task.text).toBe("look at this")
})

test("more than 8 context items block the input instead of truncating", async () => {
  const { composer, seen } = harness(withContext, () => { throw new Error("must not post") })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("too many")
  await composer.submitVisible("steer", session, null, undefined, Array.from({ length: 9 }, (_, index) => chip(`f${index}.ts`)))
  expect(posts(seen)).toEqual([])
  expect(composer.state.error).toContain("At most 8")
})

test("a context item over Core's text limit blocks the input", async () => {
  const { composer, seen } = harness(withContext, () => { throw new Error("must not post") })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("big")
  await composer.submitVisible("steer", session, null, undefined, [chip("big.ts", "x".repeat(4097))])
  expect(posts(seen)).toEqual([])
  expect(composer.state.error).toContain("too large")
})

test("an explicit retry after reload resends the byte-identical payload, context included", async () => {
  const storage = new MemoryStorage()
  const first = harness(withContext, () => { throw new Error("lost acknowledgement") }, storage)
  await first.composer.loadCapabilities()
  first.composer.observeBusy(true)
  first.composer.setText("uncertain")
  await first.composer.submitVisible("steer", session, null, undefined, [chip("a.ts")])
  expect(first.composer.state.admission?.status).toBe("unknown")
  await first.composer.persistAsync()
  const original = posts(first.seen)[0]!.body

  const second = harness(withContext, (body) => Response.json(pendingReceipt(body.requestID, body.text, "steer")), storage)
  await second.composer.loadCapabilities()
  await second.composer.retryAdmission()
  expect(JSON.stringify(posts(second.seen)[0]?.body)).toBe(JSON.stringify(original))
})

test("a restored admission whose context is invalid is fenced: no resend, saved record untouched", async () => {
  const storage = new MemoryStorage()
  const first = harness(withContext, () => { throw new Error("lost acknowledgement") }, storage)
  await first.composer.loadCapabilities()
  first.composer.observeBusy(true)
  first.composer.setText("uncertain")
  await first.composer.submitVisible("steer", session, null, undefined, [chip("a.ts")])
  await first.composer.persistAsync()
  const saved = JSON.parse(storage.getItem(storageKey)!)
  saved.admission.payload.context[0].extra = "not Core's shape"
  storage.setItem(storageKey, JSON.stringify(saved))
  const tampered = storage.getItem(storageKey)

  const second = harness(withContext, () => { throw new Error("must not post") }, storage)
  await second.composer.loadCapabilities()
  await second.composer.retryAdmission()
  second.composer.setText("new message")
  await second.composer.submitVisible("steer", session, null, undefined, [])
  expect(posts(second.seen)).toEqual([])
  expect(second.composer.restoreError()).toContain("saved request identity must be recovered")
  expect(storage.getItem(storageKey)).toBe(tampered)
})

test("a retry is refused, not stripped, when the runtime no longer advertises context", async () => {
  const storage = new MemoryStorage()
  const first = harness(withContext, () => { throw new Error("lost acknowledgement") }, storage)
  await first.composer.loadCapabilities()
  first.composer.observeBusy(true)
  first.composer.setText("uncertain")
  await first.composer.submitVisible("queue", session, null, undefined, [chip("a.ts")])
  await first.composer.persistAsync()

  const second = harness(withoutContext, () => { throw new Error("must not post") }, storage)
  await second.composer.loadCapabilities()
  await second.composer.retryAdmission()
  expect(posts(second.seen)).toEqual([])
  expect(second.composer.state.error).toContain("No retry sent")
  expect(second.composer.state.admission?.payload.context).toEqual([{ text: "contents of a.ts", source: "file", key: "a.ts" }])
})

test("capabilities expose context and nudge only when Core advertises them as true", async () => {
  const advertised = harness({ ...withContext, sessionInput: { ...withContext.sessionInput, nudge: true } }, () => new Response(null, { status: 500 }))
  await advertised.composer.loadCapabilities()
  expect(advertised.composer.state.capabilities?.sessionInput).toMatchObject({ context: true, nudge: true })
  const absent = harness(withoutContext, () => new Response(null, { status: 500 }))
  await absent.composer.loadCapabilities()
  expect(absent.composer.state.capabilities?.sessionInput).toMatchObject({ context: false, nudge: false })
})

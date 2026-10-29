// Main1569: a Front desk message to a BUSY desk session carried the desk's generated page context. With Core
// advertising sessionInput.context, the composer checked it against Core's input limits (key <= 500, text <= 4096)
// and refused the substantive message with an @context/chips reason, although the human attached no chips. A normal
// desk queue makes the generated key longer than 500 characters. (Linkage to the human's report is unproven: only an
// approximate description exists.) The send composition (input-context.ts sendContext, used by session.tsx) now
// leaves generated context that does not fit an input out of that send; chips the human chose stay strict.
import { expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { createComposer } from "./composer"
import { createImageStore } from "./image-store"
import { deskContext, type DeskItem } from "./desk"
import { sendContext } from "./input-context"
import type { ContextPart } from "./api"

const session = { id: "ses_desk", agent: "build" } as Session
const capabilities = { sessionAside: { version: 1, cancel: true },
  sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true, context: true } }

const deskComposer = () => {
  const posts: unknown[] = []
  const storage = new Map<string, string>()
  const composer = createComposer(session.id, "/desk", {
    storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) },
    images: createImageStore(),
    requestID: () => "request-1",
    prompt: async () => { throw new Error("unexpected plain send") },
    fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://desk.test").pathname
      if (path === "/oc/experimental/capabilities") return Response.json(capabilities)
      if (init?.method === "POST" && path.endsWith("/input")) {
        const body = JSON.parse(String(init.body))
        posts.push(body)
        return Response.json({ requestID: body.requestID, text: body.text, delivery: body.delivery, sessionID: session.id, agent: "build", admittedSeq: 1, timeCreated: 1, state: "pending" })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { composer, posts }
}

// A realistic desk view: 30 open items (decisions across projects), as the queue page renders them.
const items = Array.from({ length: 30 }, (_, index): DeskItem => ({
  key: `attention:opencode:es-attn-${String(index).padStart(4, "0")}-${"x".repeat(12)}`, kind: "decision",
  title: `Decision ${index}: pick the next slice`, project: "opencode", revision: `rev-${index}-${"r".repeat(8)}`, checked: 1,
  source: { session: `ses_${index}`, directory: "/w" },
}))
const note = () => {
  const note = deskContext({ now: 1_000_000, sources: [{ name: "attention", state: "current", checked: 1 }], items, briefs: [] })
  return [{ type: "text" as const, text: note.text, synthetic: true as const, metadata: { source: "front-desk", key: note.key } }]
}

test("a desk steer to a busy session is not refused because of the desk's own generated context", async () => {
  const { composer, posts } = deskComposer()
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("a substantive message for the desk")
  const generated = note()
  expect(generated[0]!.metadata.key.length).toBeGreaterThan(500)
  // Exactly as session.tsx send() composes it.
  const context = sendContext({ input: true, attaches: composer.contextAttaches("steer"), generated, chips: [] })
  await composer.submitVisible("steer", session, null, undefined, context)
  expect(composer.state.error).toBe("")
  expect(posts).toHaveLength(1)
  // The oversized note did not go, so the desk does not record it as delivered and offers it on the next send.
  expect((posts[0] as { context?: unknown }).context).toBeUndefined()
})

test("chips the human chose stay strict: an oversized chip still refuses the send", async () => {
  const { composer, posts } = deskComposer()
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("with a big chip")
  const chip: ContextPart = { type: "text", text: "x".repeat(5000), synthetic: true, metadata: { source: "file", key: "big.ts" } }
  await composer.submitVisible("steer", session, null, undefined, sendContext({ input: true, attaches: true, generated: [], chips: [chip] }))
  expect(composer.state.error).toContain("too large")
  expect(posts).toHaveLength(0)
})

test("generated context that fits goes with the input; chips take the item slots first", () => {
  const small: ContextPart = { type: "text", text: "desk note", synthetic: true, metadata: { source: "front-desk", key: "k" } }
  const chips = Array.from({ length: 8 }, (_, index): ContextPart => ({ type: "text", text: `c${index}`, synthetic: true, metadata: { source: "file", key: `c${index}` } }))
  expect(sendContext({ input: true, attaches: true, generated: [small], chips: [] })).toEqual([small])
  expect(sendContext({ input: true, attaches: true, generated: [small], chips })).toEqual(chips)
  // An idle plain send has no input limits: the whole note goes.
  const big = note()
  expect(sendContext({ input: false, attaches: true, generated: big, chips: [] })).toEqual(big)
  // Where context cannot attach at all, only chips are passed (and the composer explains them).
  expect(sendContext({ input: true, attaches: false, generated: [small], chips: [] })).toEqual([])
})

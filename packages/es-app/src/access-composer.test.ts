/* DD #897: Send behind an expired Access session waits and flushes after sign-in; a bridged host's drafts survive a
 * reconnect (a fresh controller over the same saved state) and stay apart from another host's. */
import { afterEach, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { unwrap } from "solid-js/store"
import { createImageStore } from "./image-store"
import { observeAccess, resetAccessAuth } from "./access-auth"
import { createComposer } from "./composer"

const session = { id: "ses_personal", agent: "build" } as Session
const directory = "/home/m/work"
const bridged = { id: "excalibur", label: "Excalibur", base: "/hosts/excalibur/oc" }
const capabilities = { sessionAside: { version: 1, cancel: true }, sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true } }
class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
}
afterEach(resetAccessAuth)

const harness = (storage: MemoryStorage, host = bridged) => {
  const posts: { url: string; body: unknown }[] = []
  const composer = createComposer(session.id, directory, {
    storage, images: createImageStore(), requestID: () => "request-1",
    prompt: async () => { throw new Error("Unexpected normal prompt") },
    fetch: async (url, init) => {
      if (url.includes("/experimental/capabilities")) return Response.json(capabilities)
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        posts.push({ url, body })
        return Response.json({ requestID: body.requestID, text: body.text, delivery: body.delivery, sessionID: session.id, agent: "build", admittedSeq: 1, timeCreated: 1, state: "pending" })
      }
      return new Response("not found", { status: 404 })
    },
  }, host)
  return { composer, posts }
}

test("a Steer sent while Access asks for sign-in waits, then goes once, to its own host", async () => {
  const { composer, posts } = harness(new MemoryStorage())
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setText("look at this")
  observeAccess(new Response("Unauthorized", { status: 401, headers: { "content-type": "text/html" } }), "https://agents.example")
  const sent = composer.submit(session)
  await Bun.sleep(5)
  expect(posts).toHaveLength(0)
  expect(composer.state.admission?.status).toBe("sending")
  expect(unwrap(composer.state.task).text).toBe("")
  // Typing goes on while it waits.
  composer.setText("next thought")
  observeAccess(Response.json({}), "https://agents.example")
  await sent
  expect(posts.map((post) => [post.url.split("?")[0], (post.body as { text: string }).text])).toEqual([["/hosts/excalibur/oc/session/ses_personal/input", "look at this"]])
  expect(composer.state.admission).toBeNull()
  expect(unwrap(composer.state.task).text).toBe("next thought")
})

test("a bridged host's draft survives a reconnect and stays apart from the same session on another host", async () => {
  const storage = new MemoryStorage()
  const first = harness(storage)
  first.composer.setText("personal draft")
  await first.composer.persistAsync()
  // Reconnect: a fresh controller over the same saved state.
  const again = harness(storage)
  await again.composer.persistAsync()
  expect(unwrap(again.composer.state.task).text).toBe("personal draft")
  const local = harness(storage, { id: "local", label: "Local", base: "/oc" } as never)
  expect(unwrap(local.composer.state.task).text).toBe("")
})

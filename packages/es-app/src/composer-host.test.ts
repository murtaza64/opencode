import { expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { createImageStore } from "./image-store"
import { adoptHostSessionState, createComposer, type ComposerDependencies, type InputReceipt } from "./composer"

const session = { id: "ses_same", agent: "build" } as Session
const directory = "/Users/m/repo"
const mini = { id: "mini", label: "Mac Mini", base: "/hosts/mini/oc" }
const capabilities = { sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true } }

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
}

const pending = (requestID: string, text: string, delivery: "queue" | "steer" = "queue"): InputReceipt => ({
  requestID, text, delivery, sessionID: session.id, agent: "build", admittedSeq: 1, timeCreated: 1, state: "pending",
})

type Request = { path: string; method: string; body: unknown }
// One fake Core per host prefix; every request records which host it reached.
const hosts = (storage: MemoryStorage, handle: (request: Request) => Response) => {
  const requests: Request[] = []
  let sequence = 0
  const dependencies: ComposerDependencies = {
    storage,
    images: createImageStore(),
    requestID: () => `request-${++sequence}`,
    prompt: async () => {
      throw new Error("Unexpected normal prompt")
    },
    fetch: async (url, init) => {
      const request = { path: new URL(url, "http://work.test").pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined }
      requests.push(request)
      if (request.path.endsWith("/experimental/capabilities")) return Response.json(capabilities)
      return handle(request)
    },
  }
  return { requests, dependencies }
}

test("another host's composer reads capabilities from and writes inputs to that host only", async () => {
  const storage = new MemoryStorage()
  const { requests, dependencies } = hosts(storage, (request) =>
    request.method === "POST" ? Response.json(pending("request-1", "on the mini")) : Response.json({ items: [], next: null }))
  const composer = createComposer(session.id, directory, dependencies, mini)
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("on the mini")
  await composer.submit(session)
  expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    "GET /hosts/mini/oc/experimental/capabilities",
    "POST /hosts/mini/oc/session/ses_same/input",
  ])
  expect(composer.state.receipts.map((receipt) => receipt.requestID)).toEqual(["request-1"])
})

test("the same session ID on two hosts keeps independent drafts, and this host's saved key is unchanged", () => {
  const storage = new MemoryStorage()
  const { dependencies } = hosts(storage, () => new Response("unexpected", { status: 500 }))
  const local = createComposer(session.id, directory, dependencies)
  const remote = createComposer(session.id, directory, dependencies, mini)
  local.setText("for the laptop")
  remote.setText("for the mini")
  expect(JSON.parse(storage.getItem(`es-app:composer:1:${JSON.stringify([session.id, directory])}`)!).task.text).toBe("for the laptop")
  expect(JSON.parse(storage.getItem(`es-app:composer:1:${JSON.stringify([session.id, directory, "mini"])}`)!).task.text).toBe("for the mini")
  expect(createComposer(session.id, directory, dependencies).state.task.text).toBe("for the laptop")
  expect(createComposer(session.id, directory, dependencies, mini).state.task.text).toBe("for the mini")
})

test("a lost acknowledgement on another host is read back and retried on that host with the identical payload after reload", async () => {
  const storage = new MemoryStorage()
  const { requests, dependencies } = hosts(storage, (request) => {
    if (request.method === "POST") throw new Error("lost acknowledgement")
    if (request.path.endsWith("/input")) return Response.json({ items: [], next: null })
    return new Response("not found", { status: 404 })
  })
  const composer = createComposer(session.id, directory, dependencies, mini)
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setText("check the scorer")
  await composer.submit(session)
  expect(composer.state.admission?.status).toBe("unknown")
  // Reload: a new composer for the same host and session restores the unknown admission; a local one does not.
  expect(createComposer(session.id, directory, dependencies).state.admission).toBeNull()
  const restored = createComposer(session.id, directory, dependencies, mini)
  expect(restored.state.admission?.payload.requestID).toBe("request-1")
  await restored.loadCapabilities()
  await restored.retryAdmission()
  const writes = requests.filter((request) => request.method === "POST")
  expect(writes.map((request) => request.path)).toEqual(["/hosts/mini/oc/session/ses_same/input", "/hosts/mini/oc/session/ses_same/input"])
  expect(writes[1].body).toEqual(writes[0].body)
  expect(requests.every((request) => request.path.startsWith("/hosts/mini/oc/"))).toBe(true)
})

test("the retired host view's draft and unconfirmed send move into that host's composer without being re-sent", async () => {
  const storage = new MemoryStorage()
  storage.setItem("host:mini:es-app-host-draft:ses_same", "half-written")
  storage.setItem("host:mini:es-app-host-pending:ses_same", JSON.stringify({ requestID: "legacy-1", text: "did it land?", state: "unknown" }))
  const { requests, dependencies } = hosts(storage, (request) => {
    if (request.path.endsWith("/input")) return Response.json({ items: [], next: null })
    if (request.path.endsWith("/input/legacy-1")) return Response.json(pending("legacy-1", "did it land?", "steer"))
    return new Response("not found", { status: 404 })
  })
  const composer = createComposer(session.id, directory, dependencies, mini)
  adoptHostSessionState(composer, "mini", session.id, storage)
  expect(composer.state.task.text).toBe("half-written")
  expect(composer.state.admission?.payload).toEqual({ requestID: "legacy-1", delivery: "steer", text: "did it land?" })
  expect(storage.getItem("host:mini:es-app-host-draft:ses_same")).toBeNull()
  expect(storage.getItem("host:mini:es-app-host-pending:ses_same")).toBeNull()
  await composer.loadCapabilities()
  await composer.refreshInputs()
  // Found on the Mini: settled, the draft typed since is kept, and nothing was written.
  expect(composer.state.admission).toBeNull()
  expect(composer.state.task.text).toBe("half-written")
  expect(requests.filter((request) => request.method !== "GET")).toEqual([])
  expect(requests.some((request) => request.path === "/hosts/mini/oc/session/ses_same/input/legacy-1")).toBe(true)
})

test("the retired host view's records stay where they are when the composer cannot take them", () => {
  const storage = new MemoryStorage()
  const { dependencies } = hosts(storage, () => new Response("unexpected", { status: 500 }))
  const composer = createComposer(session.id, directory, dependencies, mini)
  composer.setText("already typing")
  storage.setItem("host:mini:es-app-host-draft:ses_same", "older draft")
  storage.setItem("host:mini:es-app-host-pending:ses_same", JSON.stringify({ requestID: "legacy-2", text: "accepted one", state: "accepted" }))
  adoptHostSessionState(composer, "mini", session.id, storage)
  expect(composer.state.task.text).toBe("already typing")
  expect(storage.getItem("host:mini:es-app-host-draft:ses_same")).toBe("older draft")
  // An accepted send needs nothing carried.
  expect(storage.getItem("host:mini:es-app-host-pending:ses_same")).toBeNull()
  expect(composer.state.admission).toBeNull()
})

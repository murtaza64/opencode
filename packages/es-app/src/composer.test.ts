import { expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { unwrap } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2"
import { createImageStore, type ImageStore } from "./image-store"
import { oc } from "./api"
import {
  createComposer,
  getComposer,
  type ComposerDependencies,
  type ImageCapability,
  type InputReceipt,
} from "./composer"

const session = { id: "ses_composer", agent: "build" } as Session
const directory = "/repo with spaces/a&b?#"
const capabilities = {
  sessionAside: { version: 1, cancel: true },
  sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true },
}
const image = { id: "image-1", mime: "image/png" as const, url: "data:image/png;base64,aGVsbG8=", filename: "shot.png" }
const wireImage = { type: "file" as const, mime: image.mime, url: image.url, filename: image.filename }
const imageCapability = {
  version: 1,
  encoding: "data-url",
  mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  maxCount: 8,
  maxBytes: 5_242_880,
  maxTotalBytes: 10_485_760,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 16_777_216,
  animated: false,
  compressedMetadata: false,
} satisfies ImageCapability
const imageCapabilities = {
  sessionAside: { ...capabilities.sessionAside, images: imageCapability },
  sessionInput: { ...capabilities.sessionInput, images: imageCapability },
}
const model = { providerID: "provider", modelID: "model" }
const selectedSession = { ...session, time: { created: 1, updated: 2 }, preferredModel: { id: "model", providerID: "provider", variant: "default" } } as Session
const snapshot = {
  capturedAt: 123,
  throughMessageID: "msg_boundary",
  excludedMessageCount: 2,
  activity: { status: "busy", tools: [] },
}
const pending = (
  id = "request-1",
  text = "task",
  delivery: "queue" | "steer" = "queue",
  admittedSeq = 1,
): Extract<InputReceipt, { state: "pending" }> => ({
  requestID: id,
  text,
  delivery,
  sessionID: session.id,
  agent: "build",
  admittedSeq,
  timeCreated: 1,
  state: "pending",
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const durableImages = (): ImageStore => {
  const blobs = new Map<string, { image: Parameters<ImageStore["put"]>[0]; owners: Set<string> }>()
  return {
    volatile: false,
    put: async (image, owner) => {
      const ref = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(image.url))),
        (byte) => byte.toString(16).padStart(2, "0")).join("")
      const stored = blobs.get(ref)
      blobs.set(ref, { image, owners: new Set([...(stored?.owners ?? []), owner]) })
      return ref
    },
    get: async (ref) => blobs.get(ref)?.image,
    remove: async (refs, owner) => refs.forEach((ref) => {
      const stored = blobs.get(ref)
      stored?.owners.delete(owner)
      if (stored && !stored.owners.size) blobs.delete(ref)
    }),
  }
}
class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
}
type Request = { url: URL; method: string; body: unknown; signal: AbortSignal | null | undefined }
const harness = (
  handle: (request: Request) => Response | Promise<Response> = (request) => {
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  },
  options: ComposerDependencies = {},
  serverCapabilities: unknown = capabilities,
) => {
  const requests: Request[] = []
  const storage = options.storage ?? new MemoryStorage()
  let sequence = 0
  const dependencies: ComposerDependencies = {
    storage,
    images: createImageStore(),
    requestID: () => `request-${++sequence}`,
    prompt: async () => {
      throw new Error("Unexpected normal prompt")
    },
    fetch: async (url, init) => {
      const request = {
        url: new URL(url, "http://composer.test"),
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
        signal: init?.signal,
      }
      requests.push(request)
      if (request.url.pathname === "/oc/experimental/capabilities") return Response.json(serverCapabilities)
      return handle(request)
    },
    ...options,
  }
  const composer = createComposer(session.id, directory, dependencies)
  return { composer, requests, storage, dependencies }
}

test("setting aside an unknown input preserves newer draft and exact recovery across reload without writes", async () => {
  const { composer, requests, dependencies } = harness((request) => {
    if (request.method === "PATCH") return Response.json(selectedSession)
    if (request.method === "POST") throw new Error("lost acknowledgement")
    return new Response("not found", { status: 404 })
  }, { images: durableImages() }, imageCapabilities)
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setText("uncertain request")
  composer.setImages([image])
  composer.setModel(model)
  await composer.submit(session)
  const original = structuredClone(unwrap(composer.state.admission))
  if (!original) throw new Error("Expected an unknown admission")
  expect(original?.status).toBe("unknown")
  composer.setText("new draft")
  composer.setSelection(2, 4)
  const draft = structuredClone(unwrap(composer.state.task))
  await composer.setAsideAdmission()
  expect(composer.state.admission).toBeNull()
  expect(unwrap(composer.state.task)).toEqual(draft)
  expect(composer.blockedReason("steer")).toBe("")
  expect(composer.state.recoveries[0].admission).toEqual(original)
  await composer.persistAsync()
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  expect(restored.state.admission).toBeNull()
  expect(restored.state.recoveries[0].admission).toEqual(original)
  expect(unwrap(restored.state.task)).toEqual(draft)
  await restored.recoverAdmission("request-1")
  expect(restored.state.recoveryError).toContain("still unknown")
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(0)
})

test("set-aside recovery checks pending state without clearing a new draft or cancelling", async () => {
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") throw new Error("lost acknowledgement")
    return Response.json(pending("request-1", "uncertain request", "steer"))
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setText("uncertain request")
  await composer.submit(session)
  await composer.setAsideAdmission()
  composer.setText("new draft")
  await composer.recoverAdmission("request-1", true)
  expect(composer.state.receipts[0].state).toBe("pending")
  expect(composer.state.task.text).toBe("new draft")
  expect(composer.state.recoveries).toHaveLength(1)
  expect(requests.filter((request) => request.method !== "GET")).toHaveLength(1)
})

test("set-aside recovery retries only explicitly with exact original payload after a not-found check", async () => {
  const { composer, requests } = harness((request) => {
    if (request.method === "PATCH" || request.url.pathname.endsWith(session.id)) return Response.json(selectedSession)
    if (request.method === "POST") throw new Error("unreachable")
    return new Response("not found", { status: 404 })
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("uncertain request")
  composer.setModel(model)
  await composer.submit(session)
  await composer.setAsideAdmission()
  composer.setText("new draft")
  await composer.recoverAdmission("request-1", true)
  const writes = requests.filter((request) => request.method === "POST")
  expect(writes).toHaveLength(2)
  expect(writes[1].body).toEqual(writes[0].body)
  expect(composer.state.task.text).toBe("new draft")
  expect(composer.state.admission).toBeNull()
  expect(composer.state.recoveryError).toContain("unknown")
  expect(composer.state.recoveries).toHaveLength(1)
})

test("storage failure refuses to dismiss an unknown admission and never sends or cancels", async () => {
  const storage = new MemoryStorage()
  const { composer, requests } = harness(() => { throw new Error("unreachable") }, { storage })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setText("uncertain request")
  await composer.submit(session)
  storage.setItem = () => { throw new Error("quota exhausted") }
  await composer.setAsideAdmission()
  expect(composer.state.admission?.payload.requestID).toBe("request-1")
  expect(composer.state.recoveryError).toContain("not dismissed")
  expect(composer.state.recoveries).toHaveLength(0)
  expect(requests.filter((request) => request.method !== "GET")).toHaveLength(1)
})

test("failed atomic recovery save keeps the active input and reloads the newer text images and caret", async () => {
  const storage = new MemoryStorage()
  const { composer, requests, dependencies } = harness(() => { throw new Error("unreachable") }, { storage, images: durableImages() }, imageCapabilities)
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setText("uncertain request")
  await composer.submit(session)
  composer.setText("newer editor text")
  composer.setImages([image])
  composer.setSelection(3, 8)
  await composer.persistAsync()
  const draft = structuredClone(unwrap(composer.state.task))
  storage.setItem = () => { throw new Error("snapshot failed") }
  await composer.setAsideAdmission()
  expect(composer.state.admission?.payload.requestID).toBe("request-1")
  expect(composer.state.recoveryError).toContain("not dismissed")
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  expect(restored.state.admission?.payload.requestID).toBe("request-1")
  expect(unwrap(restored.state.task)).toEqual(draft)
  expect(restored.state.recoveries).toHaveLength(0)
  expect(requests.filter((request) => request.method !== "GET")).toHaveLength(1)
})

test("unreachable set-aside check does not retry or block another new message", async () => {
  const { composer, requests } = harness(() => { throw new Error("unreachable") })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setText("uncertain request")
  await composer.submit(session)
  await composer.setAsideAdmission()
  composer.setText("new draft")
  await composer.recoverAdmission("request-1", true)
  expect(composer.state.recoveryError).toContain("unknown")
  expect(composer.blockedReason("steer")).toBe("")
  expect(composer.state.task.text).toBe("new draft")
  expect(requests.filter((request) => request.method !== "GET")).toHaveLength(1)
})

test("recovery refuses a retry under a changed model and leaves the newer draft selection unchanged", async () => {
  let current = selectedSession
  const { composer, requests } = harness((request) => {
    if (request.method === "PATCH" || request.url.pathname.endsWith(session.id)) return Response.json(current)
    if (request.method === "POST") throw new Error("lost ack")
    return new Response("missing", { status: 404 })
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("original request")
  composer.setModel(model)
  await composer.submit(session)
  composer.setModel({ providerID: "provider", modelID: "new-model" })
  await composer.setAsideAdmission()
  expect(composer.state.recoveries[0].model).toEqual(model)
  current = { ...selectedSession, preferredModel: { id: "new-model", providerID: "provider", variant: "default" } }
  composer.setText("newer draft")
  composer.setModel({ providerID: "provider", modelID: "new-model" })
  const newer = structuredClone(unwrap(composer.state.task))
  await composer.recoverAdmission("request-1", true)
  expect(composer.state.recoveryError).toContain("Original model no longer matches")
  expect(unwrap(composer.state.task)).toEqual(newer)
  expect(requests.filter((item) => item.method === "POST")).toHaveLength(1)
  expect(requests.filter((item) => item.method === "PATCH")).toHaveLength(1)
})

test("a deferred model PATCH prevents an old-input recovery POST without changing the newer draft", async () => {
  const patch = deferred<Response>()
  const started = deferred<void>()
  const { composer, requests } = harness((request) => {
    if (request.method === "PATCH") { started.resolve(); return patch.promise }
    if (request.url.pathname.endsWith(session.id)) return Response.json(selectedSession)
    if (request.method === "POST") throw new Error("original acknowledgement lost")
    return new Response("missing", { status: 404 })
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("original request")
  await composer.submit(session, model)
  await composer.setAsideAdmission()
  expect(composer.state.recoveries).toHaveLength(1)
  composer.setText("newer draft")
  composer.setSelection(2, 5)
  const draft = structuredClone(unwrap(composer.state.task))
  const choosing = composer.chooseSessionModel({ providerID: "provider", modelID: "new-model" })
  await started.promise
  await composer.recoverAdmission("request-1", true)
  expect(composer.state.recoveryError).toContain("Model selection")
  expect(requests.filter((item) => item.method === "POST")).toHaveLength(1)
  patch.resolve(Response.json({ ...selectedSession, preferredModel: { id: "new-model", providerID: "provider" } }))
  await choosing
  expect(requests.filter((item) => item.method === "POST")).toHaveLength(1)
  expect(unwrap(composer.state.task)).toEqual(draft)
})

test("recovery model check locks out new local model PATCHes until the exact-input POST completes", async () => {
  const checking = deferred<void>()
  const checked = deferred<Response>()
  const retrying = deferred<void>()
  const retried = deferred<Response>()
  let posts = 0
  const { composer, requests } = harness((request) => {
    if (request.url.pathname.endsWith(session.id) && request.method === "GET") {
      checking.resolve()
      return checked.promise
    }
    if (request.method === "PATCH") return Response.json({ ...selectedSession, preferredModel: { id: "new-model", providerID: "provider" } })
    if (request.method === "POST") {
      if (++posts === 1) throw new Error("original acknowledgement lost")
      retrying.resolve()
      return retried.promise
    }
    return new Response("missing", { status: 404 })
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("original request")
  await composer.submit(session, model)
  await composer.setAsideAdmission()
  expect(composer.state.recoveries).toHaveLength(1)
  composer.setText("newer draft")
  composer.setSelection(2, 5)
  const draft = structuredClone(unwrap(composer.state.task))
  const recovering = composer.recoverAdmission("request-1", true)
  await checking.promise
  await composer.chooseSessionModel({ providerID: "provider", modelID: "new-model" })
  expect(requests.filter((item) => item.method === "PATCH")).toHaveLength(0)
  expect(composer.state.modelSelection).toBeNull()
  checked.resolve(Response.json(selectedSession))
  await retrying.promise
  await composer.chooseSessionModel({ providerID: "provider", modelID: "new-model" })
  expect(requests.filter((item) => item.method === "PATCH")).toHaveLength(0)
  retried.resolve(Response.json(pending("request-1", "original request", "queue")))
  await recovering
  expect(unwrap(composer.state.task)).toEqual(draft)
  const writes = requests.filter((item) => item.method === "POST")
  expect(writes).toHaveLength(2)
  expect(writes[1].body).toEqual(writes[0].body)
  await composer.chooseSessionModel({ providerID: "provider", modelID: "new-model" })
  expect(requests.filter((item) => item.method === "PATCH")).toHaveLength(1)
})

test("recovery rejects a mismatched found receipt without marking accepted or replaying", async () => {
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") throw new Error("lost ack")
    return Response.json({ ...pending("request-1", "different body", "queue"), agent: "different-agent" })
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("original request")
  await composer.submit(session)
  await composer.setAsideAdmission()
  composer.setText("newer draft")
  await composer.recoverAdmission("request-1", true)
  expect(composer.state.recoveryError).toContain("does not match")
  expect(composer.state.receipts).toHaveLength(0)
  expect(composer.state.recoveries[0].admission.payload.text).toBe("original request")
  expect(composer.state.task.text).toBe("newer draft")
  expect(requests.filter((item) => item.method !== "GET")).toHaveLength(1)
})

test.each([
  ["delivery", { delivery: "steer" }],
  ["agent", { agent: "other-agent" }],
  ["images", { images: [wireImage] }],
  ["source", { source: { type: "editspace-mail", id: "peer", sender: "a", recipient: "b" } }],
])("recovery rejects a found receipt with mismatched %s", async (_label, changed) => {
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") throw new Error("lost ack")
    return Response.json({ ...pending("request-1", "original request", "queue"), ...changed })
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("original request")
  await composer.submit(session)
  await composer.setAsideAdmission()
  await composer.recoverAdmission("request-1", true)
  expect(composer.state.recoveryError).toContain("does not match")
  expect(composer.state.receipts).toHaveLength(0)
  expect(requests.filter((item) => item.method !== "GET")).toHaveLength(1)
})

test("large-image recovery uses owned blob references within WebStorage quota and reload preserves new images and caret", async () => {
  const storage = new MemoryStorage()
  const write = storage.setItem.bind(storage)
  storage.setItem = (key, value) => {
    if (value.length > 8192) throw new Error("WebStorage quota")
    write(key, value)
  }
  const large = { ...image, url: "data:image/png;base64," + "A".repeat(2_000_000) }
  const { composer, dependencies, requests } = harness((request) => {
    if (request.method === "POST") throw new Error("lost ack")
    return new Response("missing", { status: 404 })
  }, { storage, images: durableImages() }, imageCapabilities)
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("large original")
  composer.setImages([large])
  await composer.submit(session)
  composer.setText("new draft")
  composer.setImages([image])
  composer.setSelection(2, 7)
  const draft = structuredClone(unwrap(composer.state.task))
  await composer.setAsideAdmission()
  expect(composer.state.admission).toBeNull()
  expect([...storage.data.values()].join("")).not.toContain("data:image")
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  expect(unwrap(restored.state.task)).toEqual(draft)
  expect(restored.state.recoveries[0].admission.payload.images?.[0].url).toBe(large.url)
  expect(restored.state.recoveries[0].admission.draft?.images[0].url).toBe(large.url)
  expect(requests.filter((item) => item.method === "POST")).toHaveLength(1)
})

test("missing archived image blobs fail closed across repeated reloads without retry", async () => {
  const images = durableImages()
  const { composer, dependencies, requests } = harness((request) => {
    if (request.method === "POST") throw new Error("lost ack")
    return new Response("missing", { status: 404 })
  }, { images }, imageCapabilities)
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("queue")
  composer.setText("original request")
  composer.setImages([image])
  await composer.submit(session)
  await composer.setAsideAdmission()
  images.get = async () => undefined
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  await restored.loadCapabilities()
  await restored.recoverAdmission("request-1", true)
  expect(restored.state.recoveryError).toContain("images are missing")
  const again = createComposer(session.id, directory, dependencies)
  await again.persistAsync()
  await again.recoverAdmission("request-1", true)
  expect(again.state.recoveryError).toContain("images are missing")
  expect(requests.filter((item) => item.method === "POST")).toHaveLength(1)
})

test("busy model selection waits for PATCH before admitting Queue and keeps Aside separate", async () => {
  const patch = deferred<Response>()
  const { composer, requests } = harness((request) => {
    if (request.method === "PATCH") return patch.promise
    if (request.method === "POST" && request.url.pathname.endsWith("/input")) return Response.json(pending())
    throw new Error(`Unexpected ${request.method} ${request.url.pathname}`)
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("next task")
  composer.selectMode("aside")
  composer.setModel({ providerID: "aside", modelID: "aside-model" })
  composer.selectMode("queue")
  const choosing = composer.chooseSessionModel(model)
  const sending = composer.submit(session)
  await Promise.resolve()
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0)
  expect(composer.state.task.text).toBe("next task")
  expect(composer.state.aside.model).toEqual({ providerID: "aside", modelID: "aside-model" })
  patch.resolve(Response.json(selectedSession))
  await choosing
  await sending
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(composer.state.sessionModel).toEqual(model)
  expect(composer.state.aside.model).toEqual({ providerID: "aside", modelID: "aside-model" })
})

test("lost model PATCH response reconciles GET without replay, and mismatched GET blocks task input", async () => {
  const { composer, requests } = harness((request) => {
    if (request.method === "PATCH") throw new Error("connection lost")
    if (request.method === "GET" && request.url.pathname.endsWith(session.id)) return Response.json(session)
    throw new Error(`Unexpected ${request.method} ${request.url.pathname}`)
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("do not admit")
  await composer.chooseSessionModel(model)
  await composer.submit(session)
  expect(composer.state.modelSelection?.status).toBe("unknown")
  expect(composer.state.task.text).toBe("do not admit")
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0)
})

test("two rapid selections serialize PATCHes and old replies cannot win", async () => {
  const first = deferred<Response>()
  const second = { providerID: "provider", modelID: "new-model" }
  const { composer, requests } = harness((request) => {
    if (request.method === "PATCH" && (request.body as { model: typeof model }).model.modelID === "model") return first.promise
    if (request.method === "PATCH") return Response.json({ ...selectedSession, time: { created: 1, updated: 3 }, preferredModel: { id: "new-model", providerID: "provider" } })
    throw new Error(`Unexpected ${request.method} ${request.url.pathname}`)
  })
  const older = composer.chooseSessionModel(model)
  const newer = composer.chooseSessionModel(second)
  await Promise.resolve()
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
  first.resolve(Response.json(selectedSession))
  await Promise.all([older, newer])
  expect(composer.state.sessionModel).toEqual(second)
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(2)
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0)
})

test("restored task model reconciles only on submit and keeps image and input identity on rejection", async () => {
  const storage = new MemoryStorage()
  const first = harness((request) => {
    if (request.method === "PATCH") return new Response("unavailable", { status: 400 })
    throw new Error(`Unexpected ${request.method} ${request.url.pathname}`)
  }, { storage }, imageCapabilities)
  await first.composer.loadCapabilities()
  first.composer.observeBusy(true)
  first.composer.setText("legacy task")
  first.composer.setImages([image])
  first.composer.setModel(model)
  await first.composer.persistAsync()
  const restored = createComposer(session.id, directory, first.dependencies)
  await restored.loadCapabilities()
  expect(first.requests.filter((request) => request.method === "PATCH")).toHaveLength(0)
  await restored.submit(session)
  expect(first.requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
  expect(first.requests.filter((request) => request.method === "POST")).toHaveLength(0)
  expect(unwrap(restored.state.task)).toMatchObject({ text: "legacy task", model, images: [image] })
  expect(restored.state.admission).toBeNull()
})

test("restores the normalized attachment marker with its original draft", async () => {
  const storage = new MemoryStorage()
  const first = harness(undefined, { storage })
  first.composer.setImages([{ ...image, normalized: true }])
  await first.composer.persistAsync()
  const restored = createComposer(session.id, directory, first.dependencies)
  expect(restored.state.hydrating).toBe(true)
  await restored.persistAsync()
  expect(restored.state.task.images).toEqual([{ ...image, normalized: true }])
})

test("hydration does not replace newer typing or reinterpret an image-only Send as Queue", async () => {
  const { composer, dependencies } = harness()
  composer.setImages([image])
  await composer.persistAsync()
  const restored = createComposer(session.id, directory, dependencies)
  restored.observeBusy(true)
  restored.setText("newer")
  await restored.persistAsync()
  expect(restored.state.mode).toBe("send")
  expect(restored.state.task.text).toBe("newer")
  expect(restored.state.task.images).toEqual([image])
})

test("legacy model with lost PATCH acknowledgment reconciles before one admission without PATCH replay", async () => {
  const { composer, requests } = harness((request) => {
    if (request.method === "PATCH") throw new Error("lost response")
    if (request.method === "GET" && request.url.pathname.endsWith(session.id)) return Response.json(selectedSession)
    if (request.method === "POST" && request.url.pathname.endsWith("/input")) return Response.json(pending())
    throw new Error(`Unexpected ${request.method} ${request.url.pathname}`)
  })
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setModel(model)
  composer.setText("legacy selection")
  await composer.submit(session)
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(composer.state.task.model).toBeNull()
})

test("handoff copies drafts without submitting or overwriting successor edits", async () => {
  const storage = new MemoryStorage()
  const predecessor = createComposer("ses_old", directory, { storage })
  predecessor.setVisibleText("unfinished task")
  predecessor.setImages([image], "task")
  predecessor.setVisibleModel(model)
  predecessor.restoreDraft("aside")
  predecessor.setVisibleText("aside notes")
  const successor = createComposer("ses_new", directory, { storage })
  expect(await successor.importHandoffDrafts(predecessor)).toBe(true)
  expect(successor.state.task.text).toBe("unfinished task")
  expect(successor.state.task.images).toEqual([image])
  expect(successor.state.task.model).toEqual(model)
  expect(successor.state.aside.text).toBe("aside notes")
  expect(successor.state.visibleBuffer).toBe("aside")
  expect(successor.state.admission).toBeNull()
  expect(createComposer("ses_new", directory, { storage }).state.task.text).toBe("unfinished task")
  successor.setVisibleText("newer successor edit")
  await successor.importHandoffDrafts(predecessor)
  expect(successor.state.aside.text).toBe("newer successor edit")
  expect(predecessor.state.task.text).toBe("unfinished task")
})

test("handoff keeps an image-only successor draft that is still hydrating from saved refs", async () => {
  const storage = new MemoryStorage()
  const images = createImageStore()
  const other = { id: "image-2", mime: "image/png" as const, url: "data:image/png;base64,d29ybGQ=", filename: "other.png" }
  const saved = createComposer("ses_new", directory, { storage, images })
  saved.setImages([other], "task")
  await saved.persistAsync()
  const predecessor = createComposer("ses_old", directory, { storage, images })
  predecessor.setVisibleText("predecessor text")
  predecessor.setImages([image], "task")
  await predecessor.persistAsync()
  const restoredPredecessor = createComposer("ses_old", directory, { storage, images })
  const successor = createComposer("ses_new", directory, { storage, images })
  expect(successor.state.hydrating).toBe(true)
  expect(successor.state.task.images).toEqual([])
  expect(await successor.importHandoffDrafts(restoredPredecessor)).toBe(true)
  expect(successor.state.task.text).toBe("")
  expect(successor.state.task.images).toEqual([other])
  expect(successor.state.hydrating).toBe(false)
  expect(createComposer("ses_new", directory, { storage, images }).state.task.text).toBe("")
})

test("predecessor edits after a handoff do not erase the successor's copied images", async () => {
  const storage = new MemoryStorage()
  const images = createImageStore()
  const predecessor = createComposer("ses_old", directory, { storage, images })
  predecessor.setVisibleText("carry over")
  predecessor.setImages([image], "task")
  await predecessor.persistAsync()
  const successor = createComposer("ses_new", directory, { storage, images })
  expect(await successor.importHandoffDrafts(predecessor)).toBe(true)
  predecessor.setImages([], "task")
  predecessor.setVisibleText("")
  await predecessor.persistAsync()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const restored = createComposer("ses_new", directory, { storage, images })
  await restored.persistAsync()
  expect(restored.state.task.images).toEqual([image])
})

test("handoff waits for the predecessor's own hydration before copying its images", async () => {
  const storage = new MemoryStorage()
  const images = createImageStore()
  const first = createComposer("ses_old", directory, { storage, images })
  first.setImages([image], "task")
  await first.persistAsync()
  const predecessor = createComposer("ses_old", directory, { storage, images })
  expect(predecessor.state.hydrating).toBe(true)
  const successor = createComposer("ses_new", directory, { storage, images })
  expect(await successor.importHandoffDrafts(predecessor)).toBe(true)
  expect(successor.state.task.images).toEqual([image])
})

test("explicit recovery confirms before replacing both buffers and persists selected model without requests", async () => {
  const storage = new MemoryStorage()
  const images = durableImages()
  const predecessor = createComposer("ses_old", directory, { storage, images })
  predecessor.observeSessionModel(selectedSession)
  predecessor.setVisibleText("source")
  predecessor.setImages([image])
  predecessor.setVisibleSelection(1, 3)
  predecessor.selectMode("queue")
  predecessor.setQueueAgent("plan")
  predecessor.restoreDraft("aside")
  predecessor.setVisibleText("aside source")
  predecessor.setVisibleModel({ providerID: "aside", modelID: "other" })
  await predecessor.persistAsync()
  const source = createComposer("ses_old", directory, { storage, images })
  const successor = createComposer("ses_new", directory, { storage, images, fetch: () => { throw new Error("No network") } })
  successor.setVisibleText("successor")
  const before = JSON.stringify(unwrap(successor.state))
  expect(await successor.recoverHandoffDrafts(source, async () => false)).toBe(false)
  expect(JSON.stringify(unwrap(successor.state))).toBe(before)
  const recovered = await successor.recoverHandoffDrafts(source, async (drafts) => {
    expect(drafts.task.text).toBe("source")
    expect(successor.state.task.text).toBe("successor")
    return true
  })
  expect(successor.state.storageError).toBe("")
  expect(recovered).toBe(true)
  expect(unwrap(successor.state.task)).toMatchObject({ text: "source", images: [image], selection: [1, 3], model })
  expect(successor.state.aside).toMatchObject({ text: "aside source", model: { providerID: "aside", modelID: "other" } })
  expect(successor.state).toMatchObject({ mode: "queue", visibleBuffer: "aside", queueAgent: "plan" })
  const restored = createComposer("ses_new", directory, { storage, images })
  await restored.hydrated
  expect(unwrap(restored.state.task)).toMatchObject({ text: "source", images: [image], model })
  expect(source.state.task.text).toBe("source")
})

test("explicit recovery aborts on uncertain source or destination, destination edits during staging, or storage failure", async () => {
  const storage = new MemoryStorage()
  const images = durableImages()
  const source = createComposer("ses_old", directory, { storage, images })
  source.setImages([image])
  const destination = createComposer("ses_new", directory, { storage, images })
  destination.setVisibleText("keep")
  await destination.persistAsync()
  const confirm = async () => true
  const baseline = [...storage.data.values()].find((value) => JSON.parse(value).task.text === "keep")
  const failing = createComposer("ses_new", directory, { storage: { getItem: (key) => storage.getItem(key), setItem: () => { throw new Error("quota") } }, images })
  expect(await failing.recoverHandoffDrafts(source, confirm)).toBe(false)
  expect(failing.state.task.text).toBe("keep")
  expect([...storage.data.values()]).toContain(baseline!)
  const gate = deferred<string>()
  const started = deferred<void>()
  const staging = createComposer("ses_new", directory, { storage, images: { ...images, put: async (value, owner) => { started.resolve(); await gate.promise; return images.put(value, owner) } } })
  const pendingRecovery = staging.recoverHandoffDrafts(source, confirm)
  await started.promise
  staging.setVisibleText("edited during storage")
  gate.resolve("go")
  expect(await pendingRecovery).toBe(false)
  expect(staging.state.task.text).toBe("edited during storage")
  expect(destination.state.task.text).toBe("keep")
})

test("recovery refuses uncertain or in-flight sends on either side", async () => {
  const source = createComposer("ses_old", directory, { storage: new MemoryStorage(), prompt: async () => { throw new Error("lost ACK") } })
  source.setText("uncertain")
  await source.submit({ ...session, id: "ses_old" })
  const dest = createComposer("ses_new", directory, { storage: new MemoryStorage() })
  expect(await dest.recoverHandoffDrafts(source, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("")
  source.dismissNormalSubmission()
  const sending = deferred<void>()
  const active = createComposer("ses_active", directory, { storage: new MemoryStorage(), prompt: () => sending.promise })
  active.setText("in flight")
  const pending = active.submit({ ...session, id: "ses_active" })
  expect(await dest.recoverHandoffDrafts(active, async () => true)).toBe(false)
  sending.resolve()
  await pending
  const uncertainDest = createComposer("ses_other", directory, { storage: new MemoryStorage(), prompt: async () => { throw new Error("lost ACK") } })
  uncertainDest.setText("own uncertain draft")
  await uncertainDest.submit({ ...session, id: "ses_other" })
  expect(await uncertainDest.recoverHandoffDrafts(source, async () => true)).toBe(false)
  expect(uncertainDest.state.task.text).toBe("own uncertain draft")
})

test("recovery never commits when image staging fails", async () => {
  const storage = new MemoryStorage()
  const source = createComposer("ses_old", directory, { storage })
  source.setImages([image])
  const dest = createComposer("ses_new", directory, { storage, images: {
    volatile: false,
    put: async () => { throw new Error("image database denied") },
    get: async () => undefined,
    remove: async () => {},
  } })
  dest.setText("keep")
  const before = storage.getItem(`es-app:composer:1:${JSON.stringify(["ses_new", directory])}`)
  expect(await dest.recoverHandoffDrafts(source, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("keep")
  expect(dest.state.task.images).toEqual([])
  expect(storage.getItem(`es-app:composer:1:${JSON.stringify(["ses_new", directory])}`)).toBe(before)
})

test("recovery uses the exact rejected snapshot, not later source edits, and keeps both source drafts", async () => {
  const storage = new MemoryStorage()
  const images = durableImages()
  const response = deferred<void>()
  const source = createComposer("ses_old", directory, { storage, images, prompt: () => response.promise })
  source.setQueueAgent("plan")
  source.setText("rejected")
  source.setImages([image])
  source.setSelection(2, 4)
  source.selectMode("aside")
  source.setText("other buffer")
  source.selectMode("send")
  const sending = source.submit({ ...session, id: "ses_old" })
  await source.persistAsync()
  source.setText("later edit")
  source.setImages([{ ...image, id: "later", filename: "later.png" }])
  response.reject(new (await import("./api-error")).HttpError(409, { _tag: "SessionSupersededError", sessionID: "ses_old", successor: "ses_new", state: "committed", message: "moved" }))
  await sending
  expect(unwrap(source.state.superseded?.draft)).toMatchObject({ text: "rejected", images: [image] })
  const successor = createComposer("ses_new", directory, { storage, images })
  expect(await successor.recoverHandoffDrafts(source, async (drafts) => {
    expect(drafts.task).toMatchObject({ text: "rejected", images: [image], selection: [2, 4] })
    expect(drafts.aside.text).toBe("other buffer")
    return true
  })).toBe(true)
  expect(successor.state).toMatchObject({ mode: "send", visibleBuffer: "task", queueAgent: "plan" })
  expect(unwrap(successor.state.task)).toMatchObject({ text: "rejected", images: [image], selection: [2, 4] })
  expect(source.state.task.text).toBe("later edit")
  expect(source.state.task.images[0].filename).toBe("later.png")
  const restoredSource = createComposer("ses_old", directory, { storage, images })
  const restoredSuccessor = createComposer("ses_new", directory, { storage, images })
  await Promise.all([restoredSource.hydrated, restoredSuccessor.hydrated])
  expect(unwrap(restoredSource.state.superseded?.draft)).toMatchObject({ text: "rejected", images: [image] })
  expect(unwrap(restoredSource.state.task)).toMatchObject({ text: "later edit", images: [{ filename: "later.png" }] })
  expect(unwrap(restoredSuccessor.state.task)).toMatchObject({ text: "rejected", images: [image] })
})

test("failed source persistence prevents recovery even when destination can save", async () => {
  const storage = new MemoryStorage()
  const sourceKey = `es-app:composer:1:${JSON.stringify(["ses_old", directory])}`
  let fail = false
  const guarded = {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => {
      if (fail && key === sourceKey) throw new Error("source quota")
      storage.setItem(key, value)
    },
  }
  const source = createComposer("ses_old", directory, { storage: guarded })
  source.setText("source")
  const dest = createComposer("ses_new", directory, { storage: guarded })
  dest.setText("keep")
  const destKey = `es-app:composer:1:${JSON.stringify(["ses_new", directory])}`
  const saved = storage.getItem(destKey)
  fail = true
  expect(await dest.recoverHandoffDrafts(source, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("keep")
  expect(storage.getItem(destKey)).toBe(saved)
  expect(source.state.task.text).toBe("source")
})

test("volatile image stores and existing destination supersession block explicit recovery", async () => {
  const storage = new MemoryStorage()
  const source = createComposer("ses_old", directory, { storage, images: createImageStore() })
  source.setImages([image])
  const dest = createComposer("ses_new", directory, { storage, images: createImageStore() })
  dest.setText("keep")
  expect(await dest.recoverHandoffDrafts(source, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("keep")
  const durable = durableImages()
  const durableSource = createComposer("ses_durable", directory, { storage, images: durable })
  durableSource.setImages([image])
  await durableSource.persistForRecovery()
  expect(await dest.recoverHandoffDrafts(durableSource, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("keep")
  const textSource = createComposer("ses_text", directory, { storage, images: durable })
  textSource.setText("safe")
  const conflicted = createComposer("ses_conflicted", directory, { storage, images: durable, prompt: async () => {
    throw new (await import("./api-error")).HttpError(409, {
      _tag: "SessionSupersededError", sessionID: "ses_conflicted", successor: "ses_elsewhere", state: "pending",
    })
  } })
  conflicted.setText("existing failed draft")
  await conflicted.submit({ ...session, id: "ses_conflicted" })
  const before = storage.getItem(`es-app:composer:1:${JSON.stringify(["ses_conflicted", directory])}`)
  expect(await conflicted.recoverHandoffDrafts(textSource, async () => true)).toBe(false)
  expect(storage.getItem(`es-app:composer:1:${JSON.stringify(["ses_conflicted", directory])}`)).toBe(before)
})

test("a source image store that becomes volatile during put cannot confirm recovery", async () => {
  const storage = new MemoryStorage()
  const durable = durableImages()
  let volatile = false
  const source = createComposer("ses_old", directory, { storage, images: {
    ...durable,
    get volatile() { return volatile },
    put: async (value, owner) => {
      const ref = await durable.put(value, owner)
      volatile = true
      return ref
    },
  } })
  source.setImages([image])
  const dest = createComposer("ses_new", directory, { storage, images: durable })
  dest.setText("keep")
  const key = `es-app:composer:1:${JSON.stringify(["ses_new", directory])}`
  const before = storage.getItem(key)
  expect(await dest.recoverHandoffDrafts(source, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("keep")
  expect(storage.getItem(key)).toBe(before)
  expect(source.state.storageError).toContain("tab-only")
})

test("destination image store turning volatile during put aborts recovery without replacing its drafts", async () => {
  const storage = new MemoryStorage()
  const durable = durableImages()
  const source = createComposer("ses_old", directory, { storage, images: durable })
  source.setImages([image])
  let volatile = false
  const dest = createComposer("ses_new", directory, { storage, images: {
    ...durable,
    get volatile() { return volatile },
    put: async (value, owner) => {
      const ref = await durable.put(value, owner)
      volatile = true
      return ref
    },
  } })
  dest.setText("keep")
  const key = `es-app:composer:1:${JSON.stringify(["ses_new", directory])}`
  const before = storage.getItem(key)
  expect(await dest.recoverHandoffDrafts(source, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("keep")
  expect(storage.getItem(key)).toBe(before)
  expect(dest.state.storageError).toContain("tab-only")
})

test("lost admission ACK retains exact draft through reload, edits and retry fence without unsafe recovery", async () => {
  const storage = new MemoryStorage()
  const images = durableImages()
  let posts = 0
  const source = createComposer("ses_old", directory, { storage, images, fetch: async (url, init) => {
    if (url.includes("capabilities")) return Response.json(imageCapabilities)
    if (init?.method === "POST") {
      if (++posts === 1) throw new Error("lost ACK")
      return Response.json({ _tag: "SessionSupersededError", sessionID: "ses_old", successor: "ses_new", state: "committed", message: "moved" }, { status: 409 })
    }
    if (url.includes("/input/")) return new Response(null, { status: 404 })
    throw new Error(`Unexpected ${url}`)
  } })
  await source.loadCapabilities()
  source.observeSessionModel(selectedSession)
  source.selectMode("queue")
  source.setText("rejected")
  source.setImages([image])
  source.setSelection(2, 5)
  await source.submit({ ...session, id: "ses_old" })
  expect(source.state.admission?.status).toBe("unknown")
  source.setText("later")
  source.setImages([{ ...image, id: "later", filename: "later.png" }])
  source.setModel({ providerID: "different", modelID: "later" })
  source.setSelection(0, 1)
  await source.persistAsync()
  const restored = createComposer("ses_old", directory, { storage, images, fetch: async (url, init) => {
    if (url.includes("capabilities")) return Response.json(imageCapabilities)
    if (init?.method === "POST") {
      ++posts
      return Response.json({ _tag: "SessionSupersededError", sessionID: "ses_old", successor: "ses_new", state: "committed", message: "moved" }, { status: 409 })
    }
    if (url.includes("/input/")) return new Response(null, { status: 404 })
    throw new Error(`Unexpected ${url}`)
  } })
  await restored.hydrated
  expect(unwrap(restored.state.admission?.draft)).toMatchObject({ text: "rejected", images: [image], model, selection: [2, 5] })
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(posts).toBe(2)
  expect(restored.state.admission).toMatchObject({ status: "unknown", fence: { successor: "ses_new", state: "committed" } })
  expect(unwrap(restored.state.admission?.draft)).toMatchObject({ text: "rejected", images: [image], model, selection: [2, 5] })
  expect(restored.state.superseded).toBeNull()
  expect(unwrap(restored.state.task)).toMatchObject({ text: "later", images: [{ filename: "later.png" }], model: { providerID: "different", modelID: "later" }, selection: [0, 1] })
  const dest = createComposer("ses_new", directory, { storage, images })
  expect(await dest.recoverHandoffDrafts(restored, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("")
  expect(restored.state.task.text).toBe("later")
})

test("historical unknown admission without a snapshot still cannot claim exact draft recovery", async () => {
  const storage = new MemoryStorage()
  const sourceKey = `es-app:composer:1:${JSON.stringify(["ses_old", directory])}`
  const source = createComposer("ses_old", directory, { storage, fetch: async (url, init) => {
    if (url.includes("capabilities")) return Response.json(capabilities)
    if (init?.method === "POST") throw new Error("lost ACK")
    throw new Error(`Unexpected ${url}`)
  } })
  await source.loadCapabilities()
  source.selectMode("queue")
  source.setText("rejected")
  await source.submit({ ...session, id: "ses_old" })
  const saved = JSON.parse(storage.getItem(sourceKey)!)
  delete saved.admission.draft
  storage.setItem(sourceKey, JSON.stringify(saved))
  const restored = createComposer("ses_old", directory, { storage, fetch: async (url, init) => {
    if (url.includes("capabilities")) return Response.json(capabilities)
    if (init?.method === "POST") return Response.json({ _tag: "SessionSupersededError", sessionID: "ses_old", successor: "ses_new", state: "pending", message: "moved" }, { status: 409 })
    return new Response(null, { status: 404 })
  } })
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(restored.state.admission).toMatchObject({ status: "unknown", fence: { successor: "ses_new" } })
  expect(restored.state.superseded).toBeNull()
  const dest = createComposer("ses_new", directory, { storage })
  expect(await dest.recoverHandoffDrafts(restored, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("")
})

test("input 409 remains unknown without receipt proof while normal Send rejection is definitive", async () => {
  const storage = new MemoryStorage()
  const body = { _tag: "SessionSupersededError", sessionID: session.id, successor: "ses_successor", state: "pending", message: "superseded" }
  const { composer, dependencies, requests } = harness(() => Response.json(body, { status: 409 }), { storage })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("queued draft")
  await composer.submit(session)
  expect(composer.state.admission).toMatchObject({ status: "unknown", fence: { successor: "ses_successor", state: "pending" } })
  expect(composer.state.superseded).toBeNull()
  expect(composer.state.task.text).toBe("queued draft")
  expect(createComposer(session.id, directory, dependencies).state.admission?.fence?.successor).toBe("ses_successor")
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
  const normal = harness(undefined, { prompt: async () => { throw new (await import("./api-error")).HttpError(409, body) } })
  normal.composer.setText("normal draft")
  await normal.composer.submit(session)
  expect(normal.composer.state.normalSubmission).toBeNull()
  expect(normal.composer.state.superseded).toMatchObject({ draft: { text: "normal draft" }, successor: "ses_successor" })
})

test("malformed and unrelated 409 remain unknown, while prompt preserves HTTP status and body", async () => {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(async () => Response.json({ _tag: "SessionSupersededError", sessionID: session.id, successor: "ses_next", state: "committed", message: "moved" }, { status: 409 }), { preconnect: original.preconnect })
  try {
    await expect(oc.prompt(session, directory, "draft")).rejects.toMatchObject({ status: 409, body: { successor: "ses_next" } })
  } finally {
    globalThis.fetch = original
  }
  for (const body of [{ _tag: "SessionSupersededError", sessionID: "ses_other", successor: "ses_next", state: "pending" }, { detail: "conflict" }]) {
    const { composer } = harness(() => Response.json(body, { status: 409 }))
    await composer.loadCapabilities()
    composer.selectMode("queue")
    composer.setText("draft")
    await composer.submit(session)
    expect(composer.state.admission?.status).toBe("unknown")
    expect(composer.state.superseded).toBeNull()
    const normal = harness(undefined, { prompt: async () => { throw new (await import("./api-error")).HttpError(409, body) } })
    normal.composer.setText("draft")
    await normal.composer.submit(session)
    expect(normal.composer.state.normalSubmission?.status).toBe("unknown")
    expect(normal.composer.state.superseded).toBeNull()
  }
})

test("input wake 409 preserves submitted image identity and later edits across reload", async () => {
  const storage = new MemoryStorage()
  const images = createImageStore()
  const ack = deferred<Response>()
  const { composer, dependencies, requests } = harness(() => ack.promise, { storage, images }, imageCapabilities)
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("original")
  composer.setImages([image])
  const sending = composer.submit(session)
  await Promise.resolve()
  await Promise.resolve()
  composer.setText("next edit")
  ack.resolve(Response.json({ _tag: "SessionSupersededError", sessionID: session.id, successor: "ses_next", state: "committed", message: "moved" }, { status: 409 }))
  await sending
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(composer.state.admission).toMatchObject({ status: "unknown", fence: { successor: "ses_next" } })
  expect(composer.state.task.text).toBe("next edit")
  expect(unwrap(composer.state.admission?.draft)).toMatchObject({ text: "original", images: [image] })
  await composer.persistAsync()
  const restored = createComposer(session.id, directory, dependencies)
  await restored.hydrated
  expect(unwrap(restored.state.admission?.draft)).toMatchObject({ text: "original", images: [image] })
  expect(restored.state.admission?.fence?.state).toBe("committed")
})

test.each(["pending", "promoted"] as const)("input wake 409 reconciles an already admitted %s receipt without advertising an unsent draft", async (state) => {
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") return Response.json({
      _tag: "SessionSupersededError", sessionID: session.id, successor: "ses_next", state: "committed", message: "wake fenced",
    }, { status: 409 })
    if (request.method === "GET" && request.url.pathname.endsWith("request-1"))
      return Response.json(state === "pending" ? pending("request-1", "already admitted") : { ...pending("request-1", "already admitted"), state: "promoted", messageID: "msg_admitted", timePromoted: 5 })
    throw new Error(`Unexpected ${request.method} ${request.url.pathname}`)
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("already admitted")
  await composer.submit(session)
  expect(requests.slice(1).map((request) => request.method)).toEqual(["POST", "GET"])
  expect(composer.state.admission).toBeNull()
  expect(composer.state.superseded).toBeNull()
  expect(composer.state.receipts[0].state).toBe(state)
  const dest = createComposer("ses_next", directory, { storage: new MemoryStorage() })
  expect(await dest.recoverHandoffDrafts(composer, async () => true)).toBe(true)
  expect(dest.state.task.text).toBe("")
})

test.each(["missing", "offline", "conflict"] as const)("input wake 409 with %s reconciliation stays unknown and cannot transfer the submitted payload", async (outcome) => {
  const storage = new MemoryStorage()
  const images = durableImages()
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") return Response.json({
      _tag: "SessionSupersededError", sessionID: session.id, successor: "ses_next", state: "pending", message: "wake fenced",
    }, { status: 409 })
    if (outcome === "offline") throw new Error("read failed")
    if (outcome === "conflict") return Response.json(pending("request-1", "different text"))
    return new Response(null, { status: 404 })
  }, { storage, images }, imageCapabilities)
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("unknown payload")
  composer.setImages([image])
  await composer.submit(session)
  expect(requests.slice(1).map((request) => request.method)).toEqual(["POST", "GET"])
  expect(composer.state.admission).toMatchObject({ status: "unknown", fence: { successor: "ses_next", state: "pending" } })
  expect(composer.state.superseded).toBeNull()
  expect(composer.state.task.images).toEqual([image])
  const dest = createComposer("ses_next", directory, { storage, images })
  expect(await dest.recoverHandoffDrafts(composer, async () => true)).toBe(false)
  expect(dest.state.task.text).toBe("")
  await composer.persistAsync()
  const restored = createComposer(session.id, directory, { storage, images })
  await restored.hydrated
  expect(restored.state.admission).toMatchObject({ status: "unknown", fence: { successor: "ses_next" } })
})

test("cached controllers survive reactive owner disposal and are keyed by both session and directory", () => {
  const first = createRoot((dispose) => {
    const composer = getComposer("ses_cached", "/one")
    composer.setText("retained")
    dispose()
    return composer
  })
  expect(getComposer("ses_cached", "/one")).toBe(first)
  expect(getComposer("ses_cached", "/two").state.task.text).toBe("")
  expect(getComposer("ses_other", "/one").state.task.text).toBe("")
  const observed: string[] = []
  createRoot((dispose) => {
    createComputed(() => observed.push(first.state.task.text))
    first.setText("reactive after remount")
    dispose()
  })
  expect(observed).toEqual(["retained", "reactive after remount"])
})

test("first Aside copies task text, images, model and selection without sharing the buffers", () => {
  const { composer } = harness()
  composer.setText("task")
  composer.setImages([image])
  composer.setModel(model)
  composer.setSelection(1, 3)
  composer.selectMode("aside")
  expect(composer.state.aside).toEqual(composer.state.task)
  composer.setText("question")
  composer.setImages([])
  composer.setModel(null)
  composer.setSelection(2, 4)
  composer.selectMode("queue")
  expect(unwrap(composer.state.task)).toMatchObject({ text: "task", images: [image], model, selection: [1, 3] })
  composer.selectMode("aside")
  expect(unwrap(composer.state.aside)).toMatchObject({ text: "question", images: [], model: null, selection: [2, 4] })
})

test("late image reads target the captured buffer and own their image objects", () => {
  const { composer } = harness()
  const images = [{ ...image }]
  composer.selectMode("aside")
  composer.setImages(images, "task")
  images[0].filename = "mutated.png"
  expect(composer.state.task.images).toEqual([image])
  expect(composer.state.aside.images).toEqual([])
  composer.selectMode("send")
  composer.setImages([image], "aside")
  expect(composer.state.aside.images).toEqual([image])
})

test("busy chooses Queue once and idle never reinterprets the prepared mode or sends", () => {
  const { composer, requests } = harness()
  composer.observeBusy(true)
  expect(composer.state.mode).toBe("queue")
  composer.setText("prepared draft")
  composer.observeBusy(false)
  expect(composer.state.mode).toBe("queue")
  composer.selectMode("steer")
  composer.observeBusy(true)
  composer.observeBusy(false)
  expect(composer.state.mode).toBe("steer")
  composer.selectMode("aside")
  composer.observeBusy(true)
  expect(composer.state.mode).toBe("aside")
  expect(requests).toEqual([])
})

test("an empty idle task composer returns to normal Send without sending or dropping settings", () => {
  const { composer, requests } = harness()
  composer.observeBusy(true)
  composer.setQueueAgent("plan")
  composer.selectMode("steer")
  composer.observeBusy(false)
  expect(composer.state.mode).toBe("send")
  expect(composer.state.queueAgent).toBe("plan")
  expect(requests).toEqual([])
})

test("normal drafting before a busy update is not reinterpreted as Queue", () => {
  const { composer, requests } = harness()
  composer.setText("normal draft")
  composer.observeBusy(true)
  expect(composer.state.mode).toBe("send")
  expect(composer.state.task.text).toBe("normal draft")
  expect(composer.blockedReason()).toContain("Normal Send is unavailable")
  expect(requests).toEqual([])
})

test("explicit normal Send stays selected on busy transitions and never falls through to input admission", async () => {
  const sent: string[] = []
  const { composer, requests } = harness(undefined, {
    prompt: async (_session, _directory, text) => {
      sent.push(text)
    },
  })
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setText("prepared")
  composer.observeBusy(false)
  expect(composer.state.mode).toBe("steer")
  composer.selectMode("send")
  composer.observeBusy(true)
  await composer.submit(session)
  expect(composer.state.mode).toBe("send")
  expect(composer.state.task.text).toBe("prepared")
  expect(composer.blockedReason()).toContain("Normal Send is unavailable")
  expect(sent).toEqual([])
  expect(requests).toEqual([])
  composer.observeBusy(false)
  await composer.submit(session)
  expect(sent).toEqual(["prepared"])
  expect(composer.state.normalSubmission?.status).toBe("accepted")
})

test("normal Send has immediate scoped sending feedback and a late ACK cannot clear newer typing", async () => {
  const ack = deferred<void>()
  let calls = 0
  const { composer } = harness(undefined, {
    prompt: () => {
      calls++
      return ack.promise
    },
  })
  composer.setText("first")
  const sending = composer.submit(session)
  expect(composer.state.normalSubmission?.text).toBe("first")
  expect(composer.state.normalSubmission?.status).toBe("sending")
  composer.dismissNormalSubmission()
  expect(composer.state.normalSubmission?.status).toBe("sending")
  await composer.submit(session)
  expect(calls).toBe(1)
  composer.setText("newer")
  composer.observeBusy(true)
  expect(composer.state.mode).toBe("send")
  ack.resolve()
  await sending
  expect(composer.state.normalSubmission?.status).toBe("accepted")
  expect(composer.state.task.text).toBe("newer")
  expect(composer.state.receipts).toEqual([])
})

test("reload preserves explicit Send and shows unknown legacy outcome without retrying", async () => {
  const ack = deferred<void>()
  let calls = 0
  const { composer, dependencies } = harness(undefined, {
    prompt: () => {
      calls++
      return ack.promise
    },
  })
  composer.setText("unconfirmed")
  const sending = composer.submit(session)
  const restored = createComposer(session.id, directory, dependencies)
  restored.observeBusy(true)
  expect(restored.state.mode).toBe("send")
  expect(restored.state.normalSubmission?.status).toBe("unknown")
  expect(restored.state.normalSubmission?.text).toBe("unconfirmed")
  expect(restored.state.normalSubmission?.after).toBeUndefined()
  expect(restored.state.task.text).toBe("unconfirmed")
  expect(calls).toBe(1)
  ack.reject(new Error("connection lost"))
  await sending
  expect(composer.state.normalSubmission?.status).toBe("unknown")
})

test("normal Send retains its transcript boundary through acknowledgement and reload", async () => {
  const { composer, dependencies } = harness(undefined, { prompt: async () => {} })
  composer.setText("new message")
  await composer.submitVisible("steer", session, undefined, "msg_previous")
  expect(composer.state.normalSubmission?.after).toBe("msg_previous")
  expect(composer.state.normalSubmission?.status).toBe("accepted")
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.state.normalSubmission?.after).toBe("msg_previous")
  expect(restored.state.normalSubmission?.status).toBe("accepted")
})

test("unknown normal outcome remains visible until explicitly dismissed before another normal Send", async () => {
  let calls = 0
  const { composer } = harness(undefined, {
    prompt: async () => {
      if (++calls === 1) throw new Error("lost ack")
    },
  })
  composer.setText("original")
  await composer.submit(session)
  composer.setText("different draft")
  await composer.submit(session)
  expect(calls).toBe(1)
  expect(composer.state.normalSubmission?.text).toBe("original")
  expect(composer.state.normalSubmission?.status).toBe("unknown")
  expect(composer.state.task.text).toBe("different draft")
  composer.dismissNormalSubmission()
  await composer.submit(session)
  expect(calls).toBe(2)
  expect(composer.state.normalSubmission?.text).toBe("different draft")
  expect(composer.state.normalSubmission?.status).toBe("accepted")
})

test("capability loading, failure, missing features and unknown versions fail closed", async () => {
  const response = deferred<Response>()
  const composer = createComposer(session.id, directory, { storage: null, fetch: () => response.promise })
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session)
  expect(composer.blockedReason()).toContain("not loaded")
  const load = composer.loadCapabilities()
  response.reject(new Error("offline"))
  await load
  expect(composer.state.capabilities).toBeNull()
  expect(composer.state.capabilityError).toContain("offline")
  for (const value of [
    {},
    { sessionInput: { ...capabilities.sessionInput, version: 2 } },
    { sessionInput: { ...capabilities.sessionInput, list: false } },
    { sessionInput: { ...capabilities.sessionInput, delivery: ["steer"] } },
  ]) {
    const current = createComposer(session.id, directory, { storage: null, fetch: async () => Response.json(value) })
    await current.loadCapabilities()
    current.selectMode("queue")
    expect(current.blockedReason()).toContain("does not support")
  }
})

test("explicit capability refresh ignores older responses and revokes prior support while loading", async () => {
  const old = deferred<Response>()
  let calls = 0
  const composer = createComposer(session.id, directory, {
    storage: null,
    fetch: async () => (++calls === 1 ? old.promise : Response.json({})),
  })
  const first = composer.loadCapabilities()
  await composer.loadCapabilities()
  old.resolve(Response.json(capabilities))
  await first
  composer.selectMode("aside")
  expect(composer.blockedReason()).toContain("does not support")
  expect(composer.state.capabilities).toEqual({})
})

test("media and model limits block without stripping drafts or falling back to normal prompt", async () => {
  const { composer, requests } = harness()
  await composer.loadCapabilities()
  composer.setText("task")
  composer.setImages([image])
  composer.setModel(model)
  composer.selectMode("queue")
  await composer.submit(session)
  expect(composer.blockedReason()).toContain("does not support images")
  composer.setImages([])
  expect(composer.blockedReason()).toBe("")
  composer.selectMode("aside")
  composer.setImages([image])
  await composer.submit(session)
  expect(composer.blockedReason()).toContain("does not support images")
  composer.setImages([])
  composer.setText("x".repeat(32_001))
  expect(composer.blockedReason()).toContain("32,000")
  expect(requests.map((request) => request.method)).toEqual(["GET"])
  expect(composer.state.task.model).toEqual(model)
})

test("normal send captures model, images and revision, prevents double submit, and preserves subsequent typing", async () => {
  const ack = deferred<void>()
  const sent: Parameters<NonNullable<ComposerDependencies["prompt"]>>[] = []
  const { composer } = harness(undefined, {
    prompt: async (...args) => {
      sent.push(args)
      await ack.promise
    },
  })
  composer.setText(" first ")
  composer.setImages([image])
  const sending = composer.submit(session, model)
  await composer.submit(session, model)
  composer.setText("second")
  composer.setText("third")
  ack.resolve()
  await sending
  expect(sent).toEqual([[session, directory, "first", { model, images: [image] }]])
  expect(composer.state.task.text).toBe("third")
  expect(composer.state.task.images).toEqual([image])
  expect(composer.state.sending).toBe(false)
  expect(composer.state.receipts).toEqual([])
})

test("normal acknowledgement clears only task contents, even while Aside is selected", async () => {
  const ack = deferred<void>()
  const { composer } = harness(undefined, { prompt: () => ack.promise })
  composer.setText("task")
  const sending = composer.submit(session)
  composer.selectMode("aside")
  composer.setText("question")
  ack.resolve()
  await sending
  expect(unwrap(composer.state.task)).toMatchObject({ text: "", images: [], model: null, selection: [0, 0] })
  expect(composer.state.aside.text).toBe("question")
})

test("normal send failures keep the draft and never retry automatically", async () => {
  let calls = 0
  const { composer } = harness(undefined, {
    prompt: async () => {
      calls++
      throw new Error("offline")
    },
  })
  composer.setText("task")
  await composer.submit(session)
  expect(calls).toBe(1)
  expect(composer.state.error).toContain("Check the conversation")
  expect(composer.state.task.text).toBe("task")
})

test("a different session cannot submit through this controller", async () => {
  const { composer, requests } = harness()
  composer.setText("task")
  await composer.submit({ ...session, id: "ses_other" })
  expect(composer.state.error).toContain("does not match")
  expect(requests).toEqual([])
})

test("queue admission preserves encoded directory and session defaults, clears acknowledged draft without optimistic echo", async () => {
  const { composer, requests } = harness(() => Response.json(pending()))
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session, model)
  expect(requests[1].body).toEqual({ requestID: "request-1", delivery: "queue", text: "task" })
  expect(requests[1].url.searchParams.get("directory")).toBe(directory)
  expect(requests[1].url.pathname).toBe(`/oc/session/${session.id}/input`)
  expect(composer.state.task.text).toBe("")
  expect(composer.state.admission).toBeNull()
  expect(composer.state.receipts).toEqual([pending()])
})

test("late admission cannot clear newer typing or a different controller", async () => {
  const ack = deferred<Response>()
  const { composer } = harness(() => ack.promise)
  const other = createComposer("ses_other", directory, { storage: null })
  other.setText("other session")
  await composer.loadCapabilities()
  composer.selectMode("steer")
  composer.setText("task")
  const sending = composer.submit(session)
  composer.setText("newer")
  composer.setText("newest")
  ack.resolve(Response.json(pending("request-1", "task", "steer")))
  await sending
  expect(composer.state.task.text).toBe("newest")
  expect(other.state.task.text).toBe("other session")
})

test("Queue captures its selected agent across a lost ack, edited choice, reload and exact retry", async () => {
  let posts = 0
  const { composer, requests, dependencies } = harness((request) => {
    if (request.method === "GET") return new Response(null, { status: 404 })
    if (++posts === 1) throw new Error("lost ack")
    return Response.json({ ...pending(), agent: "plan" })
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  composer.setQueueAgent("plan")
  await composer.submit(session)
  expect(requests[1].body).toEqual({ requestID: "request-1", delivery: "queue", text: "task", agent: "plan" })
  composer.setQueueAgent("build")
  await composer.persistAsync()
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.state.queueAgent).toBe("build")
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(requests.at(-1)?.body).toEqual(requests[1].body)
  expect(restored.state.task.text).toBe("task")
  expect(restored.state.queueAgent).toBe("build")
})

test("Aside and Steer omit a saved Queue-agent override, and normal Send keeps its session settings", async () => {
  const prompts: { session: Session; options: unknown }[] = []
  const { composer, requests } = harness(
    (request) =>
      request.url.pathname.endsWith("/aside")
        ? Response.json({ requestID: "request-1", text: "answer", snapshot })
        : request.method === "PATCH" ? Response.json(selectedSession) : Response.json(pending("request-2", "task", "steer")),
    {
      prompt: async (session, _directory, _text, options) => {
        prompts.push({ session, options })
      },
    },
  )
  await composer.loadCapabilities()
  composer.setQueueAgent("plan")
  composer.setText("task")
  composer.selectMode("aside")
  await composer.submit(session)
  expect(requests[1].body).toEqual({ requestID: "request-1", question: "task" })
  composer.selectMode("steer")
  await composer.submit(session)
  expect(requests[2].body).toEqual({ requestID: "request-2", delivery: "steer", text: "task" })
  composer.selectMode("send")
  composer.setText("normal")
  await composer.chooseSessionModel(model)
  composer.setImages([image])
  await composer.submit(session)
  expect(prompts).toEqual([{ session: { ...session, preferredModel: { id: "model", providerID: "provider" } }, options: { model: undefined, images: [image] } }])
  expect(composer.state.queueAgent).toBe("plan")
})

test("changing the Queue agent during admission keeps the prepared next draft", async () => {
  const ack = deferred<Response>()
  const { composer } = harness(() => ack.promise)
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  composer.setQueueAgent("plan")
  const sending = composer.submit(session)
  composer.setQueueAgent(null)
  ack.resolve(Response.json({ ...pending(), agent: "plan" }))
  await sending
  expect(composer.state.task.text).toBe("task")
  expect(composer.state.queueAgent).toBeNull()
})

test("authoritative reconciliation unlocks a stalled POST without letting its late completion unlock a newer send", async () => {
  const first = deferred<Response>()
  const second = deferred<Response>()
  const { composer } = harness((request) => {
    if (request.method === "POST")
      return (request.body as { requestID: string }).requestID === "request-1" ? first.promise : second.promise
    if (request.url.pathname.endsWith("/input")) return Response.json({ items: [pending()], next: null })
    return Response.json(pending())
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  const old = composer.submit(session)
  await composer.refreshInputs()
  expect(composer.state.admission).toBeNull()
  expect(composer.state.sending).toBe(false)
  composer.setText("next")
  const current = composer.submit(session)
  first.resolve(Response.json(pending()))
  await old
  expect(composer.state.sending).toBe(true)
  expect(composer.state.admission?.payload.requestID).toBe("request-2")
  second.resolve(Response.json(pending("request-2", "next")))
  await current
  expect(composer.state.sending).toBe(false)
})

test("definitive rejection preserves an editable draft without requiring an impossible exact retry", async () => {
  const { composer, requests } = harness((request) =>
    (request.body as { text: string }).text === "too large"
      ? new Response("too large", { status: 413 })
      : Response.json(pending("request-2", "corrected")),
  )
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("too large")
  await composer.submit(session)
  expect(composer.state.admission).toBeNull()
  expect(composer.state.task.text).toBe("too large")
  expect(composer.state.error).toContain("Input rejected")
  composer.setText("corrected")
  await composer.submit(session)
  expect(requests.at(-1)?.body).toEqual({ requestID: "request-2", text: "corrected", delivery: "queue" })
  expect(composer.state.task.text).toBe("")
})

test("refresh preserves receipt identity and stops polling terminal inputs", async () => {
  let terminal = false
  const { composer, requests } = harness((request) => {
    if (request.url.pathname.endsWith("/input"))
      return Response.json({ items: terminal ? [] : [pending()], next: null })
    return Response.json(terminal ? { ...pending(), state: "cancelled", timeCancelled: 3 } : pending())
  })
  await composer.loadCapabilities()
  await composer.refreshInputs()
  const receipt = composer.state.receipts[0]
  await composer.refreshInputs()
  expect(composer.state.receipts[0]).toBe(receipt)
  terminal = true
  await composer.refreshInputs()
  const calls = requests.length
  await composer.refreshInputs()
  expect(requests.slice(calls).map((request) => request.url.pathname)).toEqual([`/oc/session/${session.id}/input`])
  expect(composer.state.receipts[0].state).toBe("cancelled")
})

test("unknown admission retains immutable payload and an explicit retry reads before posting the same ID", async () => {
  let posts = 0
  const { composer, requests } = harness((request) => {
    if (request.method === "GET") return new Response(null, { status: 404 })
    if (++posts === 1) throw new Error("lost ack")
    return Response.json(pending())
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session)
  expect(composer.state.admission?.status).toBe("unknown")
  composer.setText("newer text")
  composer.selectMode("steer")
  composer.setModel(model)
  await composer.submit(session)
  expect(posts).toBe(1)
  await composer.retryAdmission()
  expect(requests.slice(1).map((request) => request.method)).toEqual(["POST", "GET", "POST"])
  expect(requests[3].body).toEqual(requests[1].body)
  expect(composer.state.task.text).toBe("newer text")
  expect(composer.state.admission).toBeNull()
})

test("reconciliation finds an acknowledged input without retrying POST", async () => {
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") throw new Error("lost ack")
    return Response.json({ ...pending(), state: "promoted", messageID: "msg_real", timePromoted: 4 })
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session)
  await composer.retryAdmission()
  expect(requests.slice(1).map((request) => request.method)).toEqual(["POST", "GET"])
  expect(composer.state.receipts[0]).toMatchObject({ state: "promoted", messageID: "msg_real" })
  expect(composer.state.task.text).toBe("")
})

test("failed reconciliation does not POST and duplicate retries share the sending guard", async () => {
  const read = deferred<Response>()
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") throw new Error("lost ack")
    return read.promise
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session)
  const retry = composer.retryAdmission()
  await composer.retryAdmission()
  read.reject(new Error("offline"))
  await retry
  expect(requests.slice(1).map((request) => request.method)).toEqual(["POST", "GET"])
  expect(composer.state.admission?.error).toContain("no retry was sent")
  expect(composer.state.task.text).toBe("task")
})

test("a receipt with a reused ID and different payload cannot acknowledge the draft", async () => {
  const { composer } = harness(() => Response.json(pending("request-1", "someone else's text")))
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session)
  expect(composer.state.task.text).toBe("task")
  expect(composer.state.admission?.status).toBe("unknown")
  expect(composer.state.receipts).toEqual([])
})

test("refresh traverses every pending page and reconciles individual terminal receipts", async () => {
  let listed = false
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") return Response.json(pending())
    if (request.url.pathname.endsWith("/input")) {
      listed = true
      if (request.url.searchParams.has("after"))
        return Response.json({ items: [pending("request-3", "third", "steer", 3)], next: null })
      return Response.json({ items: [pending("request-2", "second", "queue", 2)], next: 2 })
    }
    if (request.url.pathname.endsWith("request-1"))
      return Response.json({ ...pending(), state: "promoted", messageID: "msg_real", timePromoted: 3 })
    if (request.url.pathname.endsWith("request-2"))
      return Response.json({ ...pending("request-2", "second", "queue", 2), state: "cancelled", timeCancelled: 4 })
    return Response.json(pending("request-3", "third", "steer", 3))
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session)
  await composer.refreshInputs()
  expect(listed).toBe(true)
  expect(composer.state.receipts.map((receipt) => [receipt.requestID, receipt.state])).toEqual([
    ["request-1", "promoted"],
    ["request-2", "cancelled"],
    ["request-3", "pending"],
  ])
  expect(requests[3].url.searchParams.get("after")).toBe("2")
  expect(requests.slice(2).every((request) => request.url.searchParams.get("directory") === directory)).toBe(true)
  expect(composer.state.inputLoading).toBe(false)
})

test("refresh of an unknown ID only reconciles and never automatically retries admission", async () => {
  const { composer, requests } = harness((request) => {
    if (request.method === "POST") throw new Error("lost ack")
    if (request.url.pathname.endsWith("/input")) return Response.json({ items: [], next: null })
    return new Response(null, { status: 404 })
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session)
  await composer.refreshInputs()
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
  expect(composer.state.admission?.error).toContain("Retry explicitly")
})

test("pagination failure leaves known receipts intact and releases the loading guard", async () => {
  const { composer } = harness((request) => {
    if (request.url.searchParams.has("after")) throw new Error("offline")
    return Response.json({ items: [pending()], next: 1 })
  })
  await composer.loadCapabilities()
  await composer.refreshInputs()
  expect(composer.state.receipts).toEqual([pending()])
  expect(composer.state.error).toContain("offline")
  expect(composer.state.inputLoading).toBe(false)
})

test("cancel 409 rereads the receipt and reports promotion rather than cancellation", async () => {
  const { composer, requests } = harness((request) =>
    request.method === "DELETE"
      ? new Response(null, { status: 409 })
      : Response.json({ ...pending(), state: "promoted", messageID: "msg_real", timePromoted: 5 }),
  )
  await composer.loadCapabilities()
  await composer.cancelInput("request-1")
  expect(requests.slice(1).map((request) => request.method)).toEqual(["DELETE", "GET"])
  expect(composer.state.receipts[0].state).toBe("promoted")
  expect(composer.state.error).toContain("cancellation was not applied")
})

test("pending cancellation accepts the authoritative receipt and uncertain cancellation preserves pending state", async () => {
  let failure = false
  const { composer } = harness((request) => {
    if (request.method === "POST") return Response.json(pending())
    if (failure) throw new Error("lost cancel ack")
    return Response.json({ ...pending(), state: "cancelled", timeCancelled: 5 })
  })
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  await composer.submit(session)
  failure = true
  await composer.cancelInput("request-1")
  expect(composer.state.receipts[0].state).toBe("pending")
  expect(composer.state.error).toContain("not confirmed")
  failure = false
  await composer.cancelInput("request-1")
  expect(composer.state.receipts[0].state).toBe("cancelled")
})

test("a delayed pending read cannot overwrite a confirmed cancellation", async () => {
  const read = deferred<Response>()
  const reading = deferred<void>()
  const { composer } = harness((request) => {
    if (request.method === "DELETE") return Response.json({ ...pending(), state: "cancelled", timeCancelled: 5 })
    if (request.url.pathname.endsWith("/input")) return Response.json({ items: [pending()], next: null })
    reading.resolve()
    return read.promise
  })
  await composer.loadCapabilities()
  const refresh = composer.refreshInputs()
  await reading.promise
  await composer.cancelInput("request-1")
  read.resolve(Response.json(pending()))
  await refresh
  expect(composer.state.receipts[0].state).toBe("cancelled")
})

test("Aside is independent, keeps its question, sends its selected model, and never persists result text", async () => {
  const answer = deferred<Response>()
  const { composer, requests, storage, dependencies } = harness((request) =>
    request.url.pathname.endsWith("/aside") ? answer.promise : Response.json(pending("request-2")),
  )
  await composer.loadCapabilities()
  composer.setText("task")
  composer.selectMode("aside")
  composer.setText("question")
  composer.setModel(model)
  const asking = composer.submit(session)
  await composer.submit(session)
  expect(composer.state.sending).toBe(false)
  expect(requests[1].body).toEqual({ requestID: "request-1", question: "question", model })
  composer.selectMode("queue")
  await composer.submit(session)
  answer.resolve(Response.json({ requestID: "request-1", text: "EPHEMERAL ANSWER", snapshot }))
  await asking
  expect(composer.state.aside.text).toBe("question")
  expect(unwrap(composer.state.asideRequest)).toMatchObject({ status: "done", text: "EPHEMERAL ANSWER", snapshot })
  expect([...(storage as MemoryStorage).data.values()].join("")).not.toContain("EPHEMERAL ANSWER")
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.state.asideRequest).toBeNull()
  expect(restored.state.aside.text).toBe("question")
  await composer.closeAside()
  expect(composer.state.asideRequest).toBeNull()
})

test("Aside cancellation uses a fresh signal and never aborts the parent task", async () => {
  const answer = deferred<Response>()
  const { composer, requests } = harness((request) =>
    request.method === "DELETE" ? Response.json(true) : answer.promise,
  )
  await composer.loadCapabilities()
  composer.selectMode("aside")
  composer.setText("question")
  const asking = composer.submit(session)
  await composer.cancelAside()
  expect(requests[2].url.pathname).toBe(`/oc/session/${session.id}/aside/request-1`)
  expect(requests[2].signal).not.toBe(requests[1].signal)
  expect(requests[2].signal?.aborted).toBe(false)
  expect(requests[1].signal?.aborted).toBe(true)
  expect(composer.state.asideRequest?.status).toBe("cancelled")
  answer.reject(new Error("aborted"))
  await asking
  expect(composer.state.asideRequest?.status).toBe("cancelled")
  expect(requests.some((request) => request.url.pathname.endsWith("/abort"))).toBe(false)
})

test("failed Aside cancellation stays uncertain; false confirms no active request and allows dismissal", async () => {
  const answer = deferred<Response>()
  let cancels = 0
  const { composer, requests } = harness((request) => {
    if (request.method !== "DELETE") return answer.promise
    if (++cancels === 1) throw new Error("offline")
    return Response.json(false)
  })
  await composer.loadCapabilities()
  composer.selectMode("aside")
  composer.setText("question")
  const asking = composer.submit(session)
  await composer.cancelAside()
  expect(composer.state.asideRequest?.status).toBe("unknown")
  expect(composer.state.asideRequest?.error).toContain("not confirmed")
  await composer.cancelAside()
  expect(composer.state.asideRequest?.status).toBe("error")
  expect(composer.state.asideRequest?.error).toContain("No active Aside remains")
  expect(requests[1].signal?.aborted).toBe(true)
  answer.resolve(Response.json({ requestID: "request-1", text: "answer", snapshot }))
  await asking
  expect(composer.state.asideRequest?.status).toBe("error")
  await composer.closeAside()
  expect(composer.state.asideRequest).toBeNull()
  expect(composer.blockedReason()).toBe("")
})

test("late Aside answer from a cancelled request cannot overwrite a newer question", async () => {
  const old = deferred<Response>()
  const { composer } = harness((request) => {
    if (request.method === "DELETE") return Response.json(true)
    if ((request.body as { requestID: string }).requestID === "request-1") return old.promise
    return Response.json({ requestID: "request-2", text: "new answer", snapshot })
  })
  await composer.loadCapabilities()
  composer.selectMode("aside")
  composer.setText("old question")
  const first = composer.submit(session)
  await composer.closeAside()
  composer.setText("new question")
  await composer.submit(session)
  old.resolve(Response.json({ requestID: "request-1", text: "old answer", snapshot }))
  await first
  expect(composer.state.asideRequest).toMatchObject({
    requestID: "request-2",
    question: "new question",
    text: "new answer",
  })
})

test("Aside server and connection failures never automatically retry", async () => {
  const { composer, requests } = harness(() => new Response("gateway disconnected", { status: 502 }))
  await composer.loadCapabilities()
  composer.selectMode("aside")
  composer.setText("question")
  await composer.submit(session)
  expect(composer.state.asideRequest?.status).toBe("unknown")
  expect(composer.state.aside.text).toBe("question")
  expect(requests).toHaveLength(2)
})

test("unfinished Aside identity restores as unknown, without automatically resending, and remains cancellable", async () => {
  const answer = deferred<Response>()
  const { composer, requests, dependencies } = harness((request) =>
    request.method === "DELETE" ? Response.json(true) : answer.promise,
  )
  await composer.loadCapabilities()
  composer.selectMode("aside")
  composer.setText("question")
  const asking = composer.submit(session)
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.state.asideRequest).toMatchObject({ requestID: "request-1", question: "question", status: "unknown" })
  expect(requests).toHaveLength(2)
  await restored.cancelAside()
  expect(restored.state.asideRequest?.status).toBe("cancelled")
  expect(requests[2].signal?.aborted).toBe(false)
  answer.reject(new Error("offline"))
  await asking
})

test("uncertain admission and draft buffers restore with the same ID and independent selections", async () => {
  const { composer, dependencies } = harness((request) =>
    request.method === "POST" ? Promise.reject(new Error("lost ack")) : Response.json(pending()),
  )
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  composer.setSelection(1, 3)
  await composer.submit(session)
  composer.selectMode("aside")
  composer.setText("question")
  composer.setSelection(2, 5)
  composer.setImages([image])
  await composer.persistAsync()
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.state.mode).toBe("aside")
  expect(restored.state.task.selection).toEqual([1, 3])
  await restored.persistAsync()
  expect(unwrap(restored.state.aside)).toMatchObject({ text: "question", selection: [2, 5], images: [image] })
  expect(restored.state.admission).toMatchObject({
    status: "unknown",
    payload: { requestID: "request-1", delivery: "queue", text: "task" },
  })
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(restored.state.admission).toBeNull()
  expect(restored.state.task.text).toBe("")
  expect(restored.state.aside.text).toBe("question")
})

test("large image persists by reference despite a 200 KB localStorage quota", async () => {
  class ImageQuotaStorage extends MemoryStorage {
    override setItem(key: string, value: string) {
      if (value.length > 200_000) throw new Error("quota exceeded")
      super.setItem(key, value)
    }
  }
  const storage = new ImageQuotaStorage()
  const images = createImageStore()
  const { composer, dependencies } = harness(undefined, { storage, images })
  const large = { ...image, url: `data:image/png;base64,${"a".repeat(400_000)}` }
  composer.setImages([large])
  expect(await composer.persistAsync()).toBe(true)
  expect([...storage.data.values()][0]).not.toContain(large.url)
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  expect(restored.state.task.images).toEqual([large])
})

test("a missing image reference blocks a restored draft with a warning", async () => {
  const storage = new MemoryStorage()
  const images = createImageStore()
  const { composer, dependencies } = harness(undefined, { storage, images })
  composer.setImages([{ ...image, url: "data:image/png;base64,bWlzc2luZy1kcmFmdA==" }])
  await composer.persistAsync()
  const saved = JSON.parse([...storage.data.values()][0]!)
  await images.remove([saved.task.images[0].ref], [...storage.data.keys()][0]!)
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  expect(restored.state.task.images).toEqual([])
  expect(restored.state.storageError).toContain("could not be restored")
  expect(restored.blockedReason()).toContain("Images are missing")
})

test("missing admission image is reconciled by ID but cannot be retried", async () => {
  const storage = new MemoryStorage()
  const images = createImageStore()
  const { composer, dependencies, requests } = harness(
    (request) => request.method === "POST" ? Promise.reject(new Error("lost ACK")) : new Response(null, { status: 404 }),
    { storage, images }, imageCapabilities,
  )
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.selectMode("steer")
  composer.setImages([{ ...image, url: "data:image/png;base64,bWlzc2luZy1hZG1pc3Npb24=" }])
  await composer.submit(session)
  const saved = JSON.parse([...storage.data.values()][0]!)
  await images.remove([saved.admission.payload.images[0].ref], [...storage.data.keys()][0]!)
  const restored = createComposer(session.id, directory, dependencies)
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(restored.state.admission?.error).toContain("Saved images are missing")
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
})

test("Steer waits for image persistence and sends the original data URL", async () => {
  const gate = deferred<string>()
  const store = createImageStore()
  const { composer, requests, storage } = harness(
    (request) => Response.json({ ...pending("request-1", "task", "steer"), images: (request.body as { images: unknown }).images }),
    { images: { ...store, get volatile() { return false }, put: async (value, owner) => { await gate.promise; return store.put(value, owner) } } },
    imageCapabilities,
  )
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setText("task")
  composer.setImages([image])
  const sending = composer.submit(session)
  await Promise.resolve()
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0)
  gate.resolve("ready")
  await sending
  expect((requests[1].body as { images: typeof wireImage[] }).images[0].url).toBe(image.url)
  expect([...((storage as MemoryStorage).data.values())][0]).not.toContain(image.url)
})

test("GC removes an image when its acknowledged admission and draft are cleared", async () => {
  const images = createImageStore()
  let ref = ""
  const { composer, storage } = harness(
    (request) => {
      ref = JSON.parse([...(storage as MemoryStorage).data.values()][0]!).admission.payload.images[0].ref
      return Response.json({ ...pending("request-1", "", "steer"), images: (request.body as { images: unknown }).images })
    },
    { images }, imageCapabilities,
  )
  await composer.loadCapabilities()
  composer.observeBusy(true)
  composer.setImages([{ ...image, url: "data:image/png;base64,Z2MtYWRtaXNzaW9u" }])
  composer.selectMode("steer")
  await composer.submit(session)
  await composer.persistAsync()
  expect(composer.state.task.images).toEqual([])
  expect(JSON.stringify([...((storage as MemoryStorage).data.values())])).not.toContain(ref)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await images.get(ref)).toBeUndefined()
})

test("GC removes an image after it is removed from a saved draft", async () => {
  const images = createImageStore()
  const { composer, storage } = harness(undefined, { images })
  composer.setImages([{ ...image, url: "data:image/png;base64,Z2MtZHJhZnQ=" }])
  await composer.persistAsync()
  const ref = JSON.parse([...((storage as MemoryStorage).data.values())][0]!).task.images[0].ref
  composer.setImages([])
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await images.get(ref)).toBeUndefined()
})

test("unavailable storage does not discard in-memory drafts or request IDs", async () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("storage denied")
    },
  }
  const { composer } = harness(
    () => {
      throw new Error("lost ack")
    },
    { storage },
  )
  await composer.loadCapabilities()
  composer.setImages([image])
  expect(composer.state.task.images).toEqual([image])
  await composer.persistAsync()
  expect(composer.state.storageError).toContain("storage denied")
  composer.setImages([])
  composer.setText("task")
  composer.selectMode("queue")
  await composer.submit(session)
  expect(composer.state.admission?.payload.requestID).toBe("request-1")
  expect(composer.state.storageError).toContain("request IDs could not be saved")
})

test("malformed saved storage produces a visible warning without crashing the controller", () => {
  const composer = createComposer(session.id, directory, {
    storage: { getItem: () => "invalid JSON", setItem: () => {} },
  })
  expect(composer.state.storageError).toContain("Cannot restore")
  composer.setText("usable draft")
  expect(composer.state.task.text).toBe("usable draft")
})

test.each(["queue", "steer", "aside"] as const)(
  "%s accepts image-only and repeated images without UI metadata",
  async (mode) => {
    const { composer, requests } = harness(
      (request) => {
        const body = request.body as { requestID: string; images: unknown }
        return Response.json(
          mode === "aside"
            ? { requestID: body.requestID, text: "answer", snapshot }
            : { ...pending(body.requestID, "", mode), images: body.images },
        )
      },
      {},
      imageCapabilities,
    )
    await composer.loadCapabilities()
    const attachments = [
      { ...image, source: { type: "file", path: "/not-sent" } },
      { ...image, id: "repeat" },
    ]
    composer.setImages(attachments)
    composer.selectMode(mode)
    await composer.submit(session)
    expect(requests[1].body).toEqual({
      requestID: "request-1",
      ...(mode === "aside" ? { question: "" } : { text: "", delivery: mode }),
      images: [wireImage, wireImage],
    })
    if (mode === "aside") {
      expect(composer.state.asideRequest?.status).toBe("done")
      expect(composer.state.task.images).toHaveLength(2)
      expect(composer.state.aside.images).toHaveLength(2)
      return
    }
    expect(composer.state.admission).toBeNull()
    expect(composer.state.task.images).toEqual([])
  },
)

test.each([
  undefined,
  { ...imageCapability, version: 2 },
  { ...imageCapability, encoding: "url" },
  { ...imageCapability, maxCount: 0 },
  { ...imageCapability, maxBytes: "5242880" },
  { ...imageCapability, maxTotalBytes: 1.5 },
  { ...imageCapability, mimeTypes: ["image/svg+xml"] },
  { ...imageCapability, maxWidth: undefined },
  { ...imageCapability, maxHeight: 0 },
  { ...imageCapability, maxPixels: "16777216" },
  { ...imageCapability, animated: true },
  { ...imageCapability, compressedMetadata: undefined },
  { ...imageCapability, compressedMetadata: true },
])("unknown image descriptor %j fails closed while text-only remains compatible", async (images) => {
  const { composer, requests } = harness(
    () => Response.json(pending()),
    {},
    {
      sessionAside: { ...capabilities.sessionAside, images },
      sessionInput: { ...capabilities.sessionInput, images },
    },
  )
  await composer.loadCapabilities()
  composer.setText("task")
  composer.setImages([image])
  for (const mode of ["queue", "steer", "aside"] as const) {
    composer.selectMode(mode)
    await composer.submit(session)
    expect(composer.blockedReason()).toContain("does not support images")
  }
  expect(requests).toHaveLength(1)
  expect(composer.state.task.images).toEqual([image])
  expect(composer.state.aside.images).toEqual([image])
  composer.selectMode("queue")
  composer.setImages([])
  await composer.submit(session)
  expect(requests[1].body).toEqual({ requestID: "request-1", text: "task", delivery: "queue" })
})

test.each([
  [{ ...image, mime: "image/svg+xml" }, "Unsupported image format"],
  [{ ...image, url: "https://example.test/image.png" }, "data URLs"],
  [{ ...image, url: "file:///tmp/image.png" }, "data URLs"],
  [{ ...image, url: "data:image/jpeg;base64,aGVsbG8=" }, "MIME type"],
  [{ ...image, url: "data:image/png;base64," }, "Invalid base64"],
  [{ ...image, url: "data:image/png;base64,%%%=" }, "Invalid base64"],
  [{ ...image, url: "data:image/png;base64,aGVsbG8" }, "Invalid base64"],
] as const)("invalid image %j stays in the draft without a POST", async (attachment, reason) => {
  const { composer, requests } = harness(undefined, {}, imageCapabilities)
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setImages([attachment])
  await composer.submit(session)
  expect(composer.state.error).toContain(reason)
  expect(composer.state.task.images).toEqual([attachment])
  expect(requests).toHaveLength(1)
})

test("decoded per-image, total-byte and count bounds include repeated attachments", async () => {
  const { composer, requests } = harness(undefined, {}, imageCapabilities)
  await composer.loadCapabilities()
  composer.selectMode("steer")
  const large = { ...image, url: `data:image/png;base64,${Buffer.alloc(5_242_880).toString("base64")}` }
  composer.setImages([large, large])
  expect(composer.blockedReason()).toBe("")
  composer.setImages([large, large, image])
  await composer.submit(session)
  expect(composer.state.error).toContain("10485760 total bytes")
  composer.setImages([{ ...image, url: `data:image/png;base64,${Buffer.alloc(5_242_881).toString("base64")}` }])
  await composer.submit(session)
  expect(composer.state.error).toContain("5242880 bytes")
  composer.setImages(Array.from({ length: 8 }, () => image))
  expect(composer.blockedReason()).toBe("")
  composer.setImages(Array.from({ length: 9 }, () => image))
  await composer.submit(session)
  expect(composer.state.error).toContain("At most 8")
  expect(composer.state.task.images).toHaveLength(9)
  expect(requests).toHaveLength(1)
})

test("image validation honors tighter advertised bounds and supported MIME types", async () => {
  const { composer } = harness(
    undefined,
    {},
    {
      ...imageCapabilities,
      sessionInput: { ...imageCapabilities.sessionInput, images: { ...imageCapability, maxBytes: 4 } },
    },
  )
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setImages([image])
  expect(composer.blockedReason()).toContain("4 bytes")
  expect(composer.state.capabilities?.sessionInput?.images).toEqual({ ...imageCapability, maxBytes: 4 })
  for (const mime of imageCapability.mimeTypes) {
    composer.setImages([{ ...image, mime, url: `data:${mime};base64,AQID` }])
    expect(composer.blockedReason()).toBe("")
  }
})

test("lost image admission restores immutable original bytes, order and repeats for explicit retry", async () => {
  let posts = 0
  const { composer, requests, dependencies } = harness(
    (request) => {
      if (request.method === "GET") return new Response(null, { status: 404 })
      if (++posts === 1) throw new Error("lost ack")
      return Response.json({
        ...pending("request-1", ""),
        images: [wireImage, { ...wireImage, filename: "second.png" }, wireImage],
      })
    },
    {},
    imageCapabilities,
  )
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setImages([image, { ...image, filename: "second.png" }, image])
  await composer.submit(session)
  Reflect.set(composer.state.admission!.payload.images![0], "url", "data:image/png;base64,AQID")
  expect(composer.state.admission!.payload.images![0].url).toBe(image.url)
  composer.setImages([{ ...image, url: "data:image/png;base64,AQID" }])
  composer.setText("next draft")
  await composer.persistAsync()
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  expect(restored.state.admission!.payload.images![0]).toEqual(wireImage)
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(requests.slice(1).map((request) => request.method)).toEqual(["POST", "GET", "GET", "POST"])
  expect(requests.at(-1)?.body).toEqual(requests[1].body)
  expect(restored.state.admission).toBeNull()
  expect(restored.state.task.text).toBe("next draft")
  expect(restored.state.task.images[0].url).toBe("data:image/png;base64,AQID")
})

test.each([
  undefined,
  [wireImage],
  [wireImage, wireImage],
  [{ ...wireImage, filename: "second.png" }, wireImage],
  [wireImage, { ...wireImage, url: "data:image/png;base64,AQID", filename: "second.png" }],
  [wireImage, { ...wireImage, mime: "image/jpeg", filename: "second.png" }],
])("changed image receipt %j never clears a draft or permits a conflicting retry", async (images) => {
  const { composer, requests } = harness(() => Response.json({ ...pending(), images }), {}, imageCapabilities)
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  composer.setImages([image, { ...image, filename: "second.png" }])
  await composer.submit(session)
  expect(composer.state.admission?.status).toBe("unknown")
  await composer.retryAdmission()
  expect(composer.state.admission?.error).toContain("different payload")
  expect(composer.state.task.images).toHaveLength(2)
  expect(composer.state.task.text).toBe("task")
  expect(composer.state.receipts).toEqual([])
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
})

test("capability loss permits receipt reconciliation but blocks another image POST", async () => {
  let found = false
  const { composer, dependencies, requests } = harness(
    (request) => {
      if (request.method === "POST") throw new Error("lost ack")
      return found ? Response.json({ ...pending(), images: [wireImage] }) : new Response(null, { status: 404 })
    },
    {},
    imageCapabilities,
  )
  await composer.loadCapabilities()
  composer.selectMode("queue")
  composer.setText("task")
  composer.setImages([image])
  await composer.submit(session)
  const restored = createComposer(session.id, directory, {
    ...dependencies,
    fetch: (url, init) =>
      url.includes("capabilities") ? Promise.resolve(Response.json(capabilities)) : dependencies.fetch!(url, init),
  })
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(restored.state.error).toContain("does not support images")
  expect(restored.state.admission?.status).toBe("unknown")
  found = true
  await restored.retryAdmission()
  expect(restored.state.admission).toBeNull()
  expect(restored.state.task.images).toEqual([])
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1)
})

test.each([400, 413, 415, 422, 500])("HTTP %i image rejection retains task and Aside drafts", async (status) => {
  const { composer } = harness(() => new Response("unsupported image/model", { status }), {}, imageCapabilities)
  await composer.loadCapabilities()
  composer.setText("task")
  composer.setImages([image])
  composer.selectMode("queue")
  await composer.submit(session)
  expect(composer.state.task.text).toBe("task")
  expect(composer.state.task.images).toEqual([image])
  expect(composer.state.admission?.status ?? null).toBe(status < 500 ? null : "unknown")
  composer.selectMode("aside")
  await composer.submit(session)
  expect(composer.state.aside.text).toBe("task")
  expect(composer.state.aside.images).toEqual([image])
  expect(composer.state.asideRequest?.error).toContain("unsupported image/model")
})

test("Aside keeps the submitted image snapshot independent of later edits and task acknowledgement", async () => {
  const answer = deferred<Response>()
  const { composer, requests, dependencies } = harness(
    (request) =>
      request.url.pathname.endsWith("/aside")
        ? answer.promise
        : Response.json({ ...pending("request-2", ""), images: [wireImage] }),
    {},
    imageCapabilities,
  )
  await composer.loadCapabilities()
  composer.setImages([image])
  composer.selectMode("aside")
  composer.setModel(model)
  const asking = composer.submit(session)
  composer.setImages([{ ...image, filename: "next.png" }])
  composer.setText("next question")
  composer.selectMode("queue")
  await composer.submit(session)
  expect(composer.state.task.images).toEqual([])
  await composer.persistAsync()
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  expect(unwrap(restored.state.asideRequest)).toMatchObject({ question: "", images: [wireImage], status: "unknown" })
  answer.resolve(Response.json({ requestID: "request-1", text: "answer", snapshot }))
  await asking
  expect(requests[1].body).toEqual({ requestID: "request-1", question: "", images: [wireImage], model })
  expect(unwrap(composer.state.asideRequest)).toMatchObject({
    question: "",
    images: [wireImage],
    status: "done",
    snapshot,
  })
  expect(composer.state.aside.text).toBe("next question")
  expect(composer.state.aside.images[0].filename).toBe("next.png")
})

test("an image POST requires durable retry identity when localStorage denies writes", async () => {
  class ImageQuotaStorage extends MemoryStorage {
    override setItem() { throw new Error("quota exceeded") }
  }
  const { composer, requests, dependencies } = harness(
    undefined,
    { storage: new ImageQuotaStorage() },
    imageCapabilities,
  )
  await composer.loadCapabilities()
  composer.setText("task")
  composer.setImages([image])
  composer.selectMode("queue")
  await composer.submit(session)
  expect(requests).toHaveLength(1)
  expect(composer.state.error).toContain("No input was sent")
  expect(composer.state.admission).toBeNull()
  expect(composer.state.sending).toBe(false)
  expect(composer.state.task.images).toEqual([image])
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.state.admission).toBeNull()
  composer.selectMode("aside")
  await composer.submit(session)
  expect(composer.state.error).toContain("No Aside was sent")
  expect(composer.state.asideRequest).toBeNull()
  expect(composer.state.aside.images).toEqual([image])
  expect(requests).toHaveLength(1)
})

test("admission and draft images persist as references with separate identities", async () => {
  class SingleCopyStorage extends MemoryStorage {
    override setItem(key: string, value: string) {
      if (value.includes("data:image")) throw new Error("quota exceeded")
      super.setItem(key, value)
    }
  }
  const { composer, dependencies } = harness(
    (request) => {
      if (request.method === "POST") throw new Error("lost ack")
      return Response.json({ ...pending("request-1", ""), images: [wireImage] })
    },
    { storage: new SingleCopyStorage() },
    imageCapabilities,
  )
  await composer.loadCapabilities()
  composer.setImages([image])
  composer.selectMode("queue")
  await composer.submit(session)
  expect(composer.state.admission?.status).toBe("unknown")
  const restored = createComposer(session.id, directory, dependencies)
  await restored.persistAsync()
  expect(restored.state.admission?.payload.images).toEqual([wireImage])
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(restored.state.admission).toBeNull()
  expect(restored.blockedReason()).toBe("")
  expect(restored.state.storageError).toBe("")
})

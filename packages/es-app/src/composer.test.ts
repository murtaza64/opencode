import { expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { unwrap } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2"
import { createComposer, getComposer, type ComposerDependencies, type InputReceipt } from "./composer"

const session = { id: "ses_composer", agent: "build" } as Session
const directory = "/repo with spaces/a&b?#"
const capabilities = {
  sessionAside: { version: 1, cancel: true },
  sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true },
}
const image = { id: "image-1", mime: "image/png", url: "data:image/png;base64,aGVsbG8=", filename: "shot.png" }
const model = { providerID: "provider", modelID: "model" }
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
) => {
  const requests: Request[] = []
  const storage = options.storage ?? new MemoryStorage()
  let sequence = 0
  const dependencies: ComposerDependencies = {
    storage,
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
      if (request.url.pathname === "/oc/experimental/capabilities") return Response.json(capabilities)
      return handle(request)
    },
    ...options,
  }
  const composer = createComposer(session.id, directory, dependencies)
  return { composer, requests, storage, dependencies }
}

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
  expect(restored.state.task.text).toBe("unconfirmed")
  expect(calls).toBe(1)
  ack.reject(new Error("connection lost"))
  await sending
  expect(composer.state.normalSubmission?.status).toBe("unknown")
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
  expect(composer.blockedReason()).toContain("text-only")
  composer.setImages([])
  expect(composer.blockedReason()).toContain("session model")
  composer.selectMode("aside")
  composer.setImages([image])
  await composer.submit(session)
  expect(composer.blockedReason()).toContain("text-only")
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
  composer.setModel(model)
  const sending = composer.submit(session)
  composer.selectMode("aside")
  composer.setText("question")
  ack.resolve()
  await sending
  expect(unwrap(composer.state.task)).toMatchObject({ text: "", images: [], model, selection: [0, 0] })
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
        : Response.json(pending("request-2", "task", "steer")),
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
  composer.setModel(model)
  composer.setImages([image])
  await composer.submit(session)
  expect(prompts).toEqual([{ session, options: { model, images: [image] } }])
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
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.state.mode).toBe("aside")
  expect(restored.state.task.selection).toEqual([1, 3])
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

test("quota fallback keeps live images and persists a reload warning that typing cannot silently clear", async () => {
  class ImageQuotaStorage extends MemoryStorage {
    override setItem(key: string, value: string) {
      if (value.includes("data:image")) throw new Error("quota exceeded")
      super.setItem(key, value)
    }
  }
  const storage = new ImageQuotaStorage()
  const { composer, dependencies } = harness(undefined, { storage })
  composer.setText("task with image")
  composer.setImages([image])
  expect(composer.state.task.images).toEqual([image])
  expect(composer.state.storageError).toContain("this tab only")
  composer.setText("still with image")
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.state.task.images).toEqual([])
  expect(restored.state.storageError).toContain("could not be restored")
  restored.setText("typed after reload")
  expect(restored.state.storageError).toContain("could not be restored")
  expect(restored.blockedReason()).toContain("Images are missing")
  await restored.submit(session)
  expect(restored.state.task.text).toBe("typed after reload")
  const again = createComposer(session.id, directory, dependencies)
  expect(again.state.storageError).toContain("could not be restored")
  again.selectMode("aside")
  expect(again.blockedReason()).toContain("Images are missing")
  again.setImages([], "aside")
  again.selectMode("send")
  expect(again.blockedReason()).toContain("Images are missing")
  again.setImages([], "task")
  expect(again.state.storageError).toBe("")
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

import { expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { createComposer, type ComposerDependencies } from "./composer"

const session = { id: "ses_direct", agent: "build" } as Session
const directory = "/visible draft & images"
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const harness = (
  handle: (url: string, init?: RequestInit) => Promise<Response>,
  options: ComposerDependencies = {},
) => {
  const records = new Map<string, string>()
  let id = 0
  const dependencies: ComposerDependencies = {
    storage: {
      getItem: (key) => records.get(key) ?? null,
      setItem: (key, value) => {
        records.set(key, value)
      },
    },
    requestID: () => `request-${++id}`,
    fetch: (url, init) =>
      url.includes("/capabilities")
        ? Promise.resolve(
            Response.json({
              sessionAside: { version: 1, cancel: true },
              sessionInput: { version: 1, delivery: ["queue", "steer"], list: true, cancel: true },
            }),
          )
        : handle(url, init),
    prompt: async () => {
      throw new Error("Unexpected chat-start transport")
    },
    ...options,
  }
  return { composer: createComposer(session.id, directory, dependencies), dependencies, records }
}
const receipt = (requestID: string, text: string, delivery: "queue" | "steer" = "queue") => ({
  requestID,
  text,
  delivery,
  sessionID: session.id,
  agent: "build",
  admittedSeq: 1,
  state: "pending",
  timeCreated: 1,
})
const snapshot = { capturedAt: 1, excludedMessageCount: 0, activity: { status: "busy", tools: [] } }

test("direct Aside uses visible text, not the keyboard target or hidden old Aside buffer", async () => {
  const bodies: unknown[] = []
  const { composer } = harness(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ requestID: "request-1", text: "answer", snapshot })
  })
  await composer.loadCapabilities()
  composer.selectMode("aside")
  composer.setText("hidden old Aside")
  composer.setVisibleText("current visible message")
  composer.selectTarget("queue")
  await composer.submitVisible("aside", session)
  expect(bodies).toEqual([{ requestID: "request-1", question: "current visible message" }])
  expect(composer.state.aside.text).toBe("hidden old Aside")
  expect(composer.visibleDraft().text).toBe("")
  expect(composer.state.keyboardTarget).toBe("steer")
})

test("target cycling leaves the visible text, images and cursor unchanged and never sends", () => {
  let calls = 0
  const { composer } = harness(async () => {
    calls++
    throw new Error("unexpected")
  })
  const image = { id: "image", mime: "image/png", filename: "saved.png", url: "data:image/png;base64,YQ==" }
  composer.setVisibleText("visible")
  composer.setImages([image], "task")
  composer.setVisibleSelection(2, 5)
  const revision = composer.visibleDraft().revision
  composer.selectTarget("queue")
  composer.selectTarget("aside")
  composer.selectTarget("steer")
  expect(composer.visibleDraft().text).toBe("visible")
  expect(composer.visibleDraft().images).toEqual([image])
  expect(composer.visibleDraft().selection).toEqual([2, 5])
  expect(composer.visibleDraft().revision).toBe(revision)
  expect(calls).toBe(0)
})

test("late Queue ACK never clears newer typing or overrides a newer keyboard target", async () => {
  const ack = deferred<Response>()
  const { composer } = harness(() => ack.promise)
  await composer.loadCapabilities()
  composer.setVisibleText("first")
  const sending = composer.submitVisible("queue", session)
  composer.setVisibleText("newer")
  composer.selectTarget("aside")
  ack.resolve(Response.json(receipt("request-1", "first")))
  await sending
  expect(composer.visibleDraft().text).toBe("newer")
  expect(composer.state.keyboardTarget).toBe("aside")
})

test("ACK may clear its unchanged draft but keeps a target selected after submission", async () => {
  const ack = deferred<Response>()
  const { composer } = harness(() => ack.promise)
  await composer.loadCapabilities()
  composer.setVisibleText("first")
  const sending = composer.submitVisible("queue", session)
  composer.selectTarget("queue")
  ack.resolve(Response.json(receipt("request-1", "first")))
  await sending
  expect(composer.visibleDraft().text).toBe("")
  expect(composer.state.keyboardTarget).toBe("queue")
  composer.setVisibleText("next")
  composer.setVisibleText("")
  expect(composer.state.keyboardTarget).toBe("steer")
})

test("idle Steer starts in chat; busy Steer captures durable safe-boundary delivery", async () => {
  const chat: unknown[] = []
  const inputs: unknown[] = []
  const { composer } = harness(
    async (_url, init) => {
      inputs.push(JSON.parse(String(init?.body)))
      return Response.json(receipt("request-1", "busy message", "steer"))
    },
    {
      prompt: async (_session, _directory, text, options) => {
        chat.push({ text, options })
      },
    },
  )
  await composer.loadCapabilities()
  composer.setVisibleText("idle message")
  composer.selectTarget("aside")
  await composer.submitVisible("steer", session)
  expect(chat).toEqual([{ text: "idle message", options: { images: [], model: undefined } }])
  expect(composer.state.receipts).toEqual([])
  composer.observeBusy(true)
  composer.setQueueAgent("plan")
  composer.setVisibleText("busy message")
  await composer.submitVisible("steer", session)
  expect(inputs).toEqual([{ requestID: "request-1", delivery: "steer", text: "busy message" }])
})

test("unknown ACK retry preserves original ID and payload across newer target/text and reload", async () => {
  const posted: unknown[] = []
  const { composer, dependencies } = harness(async (_url, init) => {
    if (!init?.method) return new Response(null, { status: 404 })
    posted.push(JSON.parse(String(init.body)))
    if (posted.length === 1) throw new Error("lost ACK")
    return Response.json(receipt("request-1", "original"))
  })
  await composer.loadCapabilities()
  composer.setVisibleText("original")
  await composer.submitVisible("queue", session)
  composer.setVisibleText("newer")
  composer.selectTarget("aside")
  const restored = createComposer(session.id, directory, dependencies)
  await restored.loadCapabilities()
  await restored.retryAdmission()
  expect(posted).toEqual([
    { requestID: "request-1", delivery: "queue", text: "original" },
    { requestID: "request-1", delivery: "queue", text: "original" },
  ])
  expect(restored.visibleDraft().text).toBe("newer")
  expect(restored.state.keyboardTarget).toBe("aside")
})

test("legacy migration displays the previously visible Aside draft and keeps the other draft recoverable", async () => {
  const { composer, dependencies, records } = harness(async () =>
    Response.json(receipt("request-1", "old visible Aside")),
  )
  composer.setVisibleText("saved task")
  composer.selectMode("aside")
  composer.setText("old visible Aside")
  const [key, raw] = [...records][0]!
  const legacy = JSON.parse(raw)
  delete legacy.directView
  delete legacy.visibleBuffer
  records.set(key, JSON.stringify(legacy))
  const restored = createComposer(session.id, directory, dependencies)
  expect(restored.visibleDraft().text).toBe("old visible Aside")
  expect(restored.state.keyboardTarget).toBe("steer")
  await restored.loadCapabilities()
  await restored.submitVisible("queue", session)
  expect(restored.state.task.text).toBe("saved task")
  expect(restored.visibleDraft().text).toBe("")
  restored.restoreDraft("task")
  expect(restored.visibleDraft().text).toBe("saved task")
})

test("late Aside answer retains newer visible text and duplicate requests are blocked", async () => {
  const ack = deferred<Response>()
  let calls = 0
  const { composer } = harness(async () => {
    calls++
    return ack.promise
  })
  await composer.loadCapabilities()
  composer.setVisibleText("question")
  const asking = composer.submitVisible("aside", session)
  await composer.submitVisible("aside", session)
  expect(calls).toBe(1)
  composer.setVisibleText("new question")
  composer.selectTarget("queue")
  ack.resolve(Response.json({ requestID: "request-1", text: "answer", snapshot }))
  await asking
  expect(composer.visibleDraft().text).toBe("new question")
  expect(composer.state.keyboardTarget).toBe("queue")
})

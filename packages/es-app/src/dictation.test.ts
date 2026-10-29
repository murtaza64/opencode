import { expect, test } from "bun:test"
import { createComposer, dictationInsert, getComposer } from "./composer"
import { createDictation, dictationTarget, type DictationTarget } from "./dictation"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const memory = () => {
  const records = new Map<string, string>()
  return { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => void records.set(key, value) }
}
const composer = (sessionID: string) =>
  createComposer(sessionID, "/repo", { storage: memory(), fetch: async () => Response.json({}) })

// A scripted native bridge: each POST resolves when the test releases it.
const bridge = (status: object = { available: true, state: "idle" }) => {
  const calls: { action: string; id?: string }[] = []
  const pending = new Map<string, ReturnType<typeof deferred<Response>>>()
  const fetch = async (url: string, init?: RequestInit) => {
    if (url === "/__es/voice") return Response.json(status)
    const action = url.split("/").at(-1)!
    calls.push({ action, id: JSON.parse(String(init?.body)).id })
    if (action === "cancel") return Response.json({ ok: true })
    const next = deferred<Response>()
    pending.set(action, next)
    return next.promise
  }
  const release = async (action: string, response: Response) => {
    for (let i = 0; i < 50 && !pending.has(action); i++) await Promise.resolve()
    pending.get(action)!.resolve(response)
    pending.delete(action)
    await new Promise((done) => setTimeout(done, 0))
  }
  return { fetch, calls, release }
}
const setup = (status?: object) => {
  const net = bridge(status)
  const composers = { a: composer("ses_a"), b: composer("ses_b") }
  const voice = createDictation({
    fetch: net.fetch,
    insert: (target, text) => composers[target.sessionID === "ses_a" ? "a" : "b"].insertDictation(target.buffer, target, text),
  })
  const target = (key: "a" | "b" = "a"): DictationTarget =>
    dictationTarget(`ses_${key}`, "/repo", composers[key].state.visibleBuffer, composers[key].state[composers[key].state.visibleBuffer])
  return { net, composers, voice, target }
}

test("a remote transcript falls back to its host's draft after switching hosts with the same session and directory", async () => {
  const net = bridge()
  const session = `ses_${crypto.randomUUID()}`
  const host = { id: "mini", base: "/hosts/mini/oc" }
  const local = getComposer(session, "/repo")
  const remote = getComposer(session, "/repo", host)
  const other = getComposer(session, "/repo", { id: "other", base: "/hosts/other/oc" })
  const voice = createDictation({ fetch: net.fetch })
  local.setText("local draft")
  other.setText("other host draft")
  remote.setText("Please review")
  remote.setSelection(13, 13)
  remote.setImages([{ id: "image", mime: "image/png", url: "data:image/png;base64,AA==", filename: "shot.png" }])
  remote.setModel({ providerID: "fixture", modelID: "test" })
  const target = dictationTarget(session, "/repo", "task", remote.state.task, host)
  await voice.refresh()
  const starting = voice.start(target)
  await net.release("start", Response.json({ ok: true }))
  await starting
  const stopping = voice.stop()
  // An editor for this same session on Local must not receive the remote result.
  const localEdits: string[] = []
  const detach = voice.attach({ sessionID: session, directory: "/repo" }, (_target, text) => {
    localEdits.push(text)
    return true
  })
  remote.setText("Please review this")
  remote.setSelection(18, 18)
  await net.release("stop", Response.json({ ok: true, text: "carefully" }))
  await stopping
  detach()
  expect(remote.state.task.text).toBe("Please review this carefully")
  expect(remote.state.task.images.map((image) => image.id)).toEqual(["image"])
  expect(remote.state.task.model).toEqual({ providerID: "fixture", modelID: "test" })
  expect(remote.state.normalSubmission).toBeNull()
  expect(local.state.task.text).toBe("local draft")
  expect(other.state.task.text).toBe("other host draft")
  expect(localEdits).toEqual([])
  expect(net.calls.map((call) => call.action)).toEqual(["start", "stop"])
})

test("focused dictation editors, ownership and errors are isolated by host, not only session and directory", async () => {
  const net = bridge()
  const voice = createDictation({ fetch: net.fetch })
  const remote = { sessionID: "ses_same", directory: "/repo", host: { id: "mini", base: "/hosts/mini/oc" } }
  const local = { sessionID: "ses_same", directory: "/repo" }
  const remoteEdits: string[] = []
  const localEdits: string[] = []
  voice.attach(remote, (_target, text) => { remoteEdits.push(text); return true })
  const detachLocal = voice.attach(local, (_target, text) => { localEdits.push(text); return true })
  const target = dictationTarget(remote.sessionID, remote.directory, "task", { revision: 0, selection: [0, 0] }, remote.host)
  await voice.refresh()
  const starting = voice.start(target)
  await net.release("start", Response.json({ ok: true }))
  await starting
  expect(voice.owns(voice.state.target, remote)).toBe(true)
  expect(voice.owns(voice.state.target, local)).toBe(false)
  await voice.toggle({ ...target, host: undefined })
  expect(voice.state.phase).toBe("recording")
  // Cleaning up a different host's editor must not detach the remote editor.
  detachLocal()
  const stopping = voice.stop()
  await net.release("stop", Response.json({ ok: true, text: "remote text" }))
  await stopping
  expect(remoteEdits).toEqual(["remote text"])
  expect(localEdits).toEqual([])

  const denied = voice.start(target)
  await net.release("start", Response.json({ ok: false, code: "permission", message: "Microphone access denied" }, { status: 403 }))
  await denied
  expect(voice.owns(voice.state.error?.target, remote)).toBe(true)
  expect(voice.owns(voice.state.error?.target, local)).toBe(false)
  expect(voice.state.error?.action).toBe("settings")
})

test("stop transcribes into the draft at the captured selection, keeping images and model, and never sends", async () => {
  const { net, composers, voice, target } = setup()
  const draft = composers.a
  draft.setText("Fix the bug please")
  draft.setImages([{ id: "img", mime: "image/png", url: "data:image/png;base64,AA==", filename: "shot.png" }], "task")
  draft.setModel({ providerID: "p", modelID: "m" })
  draft.setSelection(8, 11)
  await voice.refresh()
  const starting = voice.start(target())
  expect(voice.state.phase).toBe("starting")
  await net.release("start", Response.json({ ok: true }))
  await starting
  expect(voice.state.phase).toBe("recording")
  const stopping = voice.stop()
  expect(voice.state.phase).toBe("transcribing")
  await net.release("stop", Response.json({ ok: true, text: "crash on login" }))
  await stopping
  expect(draft.state.task.text).toBe("Fix the crash on login please")
  expect(draft.state.task.selection).toEqual([22, 22])
  expect(draft.state.task.images.map((image) => image.id)).toEqual(["img"])
  expect(draft.state.task.model).toEqual({ providerID: "p", modelID: "m" })
  expect(draft.state.normalSubmission).toBeNull()
  expect(voice.state.phase).toBe("idle")
  expect(net.calls.map((call) => call.action)).toEqual(["start", "stop"])
})

test("typing during transcription is kept and the transcript goes in at the current caret", async () => {
  const { net, composers, voice, target } = setup()
  const draft = composers.a
  draft.setText("Hello")
  draft.setSelection(5, 5)
  await voice.refresh()
  const starting = voice.start(target())
  await net.release("start", Response.json({ ok: true }))
  await starting
  const stopping = voice.stop()
  draft.setText("Hello world. Also")
  draft.setSelection(17, 17)
  await net.release("stop", Response.json({ ok: true, text: "check the logs." }))
  await stopping
  expect(draft.state.task.text).toBe("Hello world. Also check the logs.")
})

test("navigating to another conversation does not move the transcript there", async () => {
  const { net, composers, voice, target } = setup()
  await voice.refresh()
  const starting = voice.start(target("a"))
  await net.release("start", Response.json({ ok: true }))
  await starting
  composers.b.setText("other draft")
  // Another composer's shortcut does not stop someone else's dictation.
  await voice.toggle(target("b"))
  expect(voice.state.phase).toBe("recording")
  const stopping = voice.stop()
  await net.release("stop", Response.json({ ok: true, text: "for A" }))
  await stopping
  expect(composers.a.state.task.text).toBe("for A")
  expect(composers.b.state.task.text).toBe("other draft")
})

test("a result arriving after cancel is ignored and the draft is unchanged", async () => {
  const { net, composers, voice, target } = setup()
  composers.a.setText("keep me")
  await voice.refresh()
  const starting = voice.start(target())
  await net.release("start", Response.json({ ok: true }))
  await starting
  const stopping = voice.stop()
  await voice.cancel()
  expect(voice.state.phase).toBe("idle")
  await net.release("stop", Response.json({ ok: true, text: "late" }))
  await stopping
  expect(composers.a.state.task.text).toBe("keep me")
  expect(voice.state.error).toBeNull()
  expect(net.calls.map((call) => call.action)).toEqual(["start", "stop", "cancel"])
})

test("cancel while starting cancels the capture the shell may have started", async () => {
  const { net, voice, target } = setup()
  await voice.refresh()
  const starting = voice.start(target())
  await voice.cancel()
  await net.release("start", Response.json({ ok: true }))
  await starting
  expect(voice.state.phase).toBe("idle")
  expect(net.calls.map((call) => call.action)).toEqual(["start", "cancel", "cancel"])
})

test("a second start while one is active sends nothing", async () => {
  const { net, voice, target } = setup()
  await voice.refresh()
  const first = voice.start(target("a"))
  await voice.start(target("b"))
  await net.release("start", Response.json({ ok: true }))
  await first
  expect(net.calls.map((call) => call.action)).toEqual(["start"])
  expect(voice.owns(voice.state.target, { sessionID: "ses_a", directory: "/repo" })).toBe(true)
})

test("denied microphone access reports a retryable error on that composer and leaves the draft", async () => {
  const { net, composers, voice, target } = setup()
  composers.a.setText("draft")
  await voice.refresh()
  const starting = voice.start(target())
  await net.release("start", Response.json({ ok: false, code: "permission", message: "Microphone access is off." }, { status: 403 }))
  await starting
  expect(voice.state.phase).toBe("idle")
  expect(voice.state.error).toMatchObject({ message: "Microphone access is off.", action: "settings", target: { sessionID: "ses_a" } })
  expect(composers.a.state.task.text).toBe("draft")
})

test("no speech is not offered as a retry and inserts nothing", async () => {
  const { net, composers, voice, target } = setup()
  await voice.refresh()
  const starting = voice.start(target())
  await net.release("start", Response.json({ ok: true }))
  await starting
  const stopping = voice.stop()
  await net.release("stop", Response.json({ ok: false, code: "empty", message: "No speech detected." }, { status: 422 }))
  await stopping
  expect(voice.state.error).toMatchObject({ message: "No speech detected.", action: null })
  expect(composers.a.state.task.text).toBe("")
})

test("missing pipeline exposes its setup reason and never starts capture", async () => {
  const { net, voice, target } = setup({ available: false, missing: "transcriber", message: "Install whisper-cpp.", state: "idle" })
  await voice.refresh()
  expect(voice.state).toMatchObject({ availability: "setup", setup: "Install whisper-cpp." })
  await voice.start(target())
  expect(net.calls).toEqual([])
  expect(voice.state.phase).toBe("idle")
})

test("a failed transcription keeps its technical detail and offers a retry", async () => {
  const { net, composers, voice, target } = setup()
  composers.a.setText("draft")
  await voice.refresh()
  const starting = voice.start(target())
  await net.release("start", Response.json({ ok: true }))
  await starting
  const stopping = voice.stop()
  await net.release("stop", Response.json({ ok: false, code: "failed", message: "Couldn't transcribe the recording", detail: "failed to load model" }, { status: 500 }))
  await stopping
  expect(voice.state.error).toMatchObject({ message: "Couldn't transcribe the recording", detail: "failed to load model", action: "retry" })
  expect(composers.a.state.task.text).toBe("draft")
})

test("a mounted, focused editor takes the transcript instead of the saved draft", async () => {
  const { net, composers, voice, target } = setup()
  const landed: string[] = []
  const detach = voice.attach({ sessionID: "ses_a", directory: "/repo" }, (_target, text) => {
    landed.push(text)
    return true
  })
  await voice.refresh()
  const starting = voice.start(target())
  await net.release("start", Response.json({ ok: true }))
  await starting
  const stopping = voice.stop()
  await net.release("stop", Response.json({ ok: true, text: "in the editor" }))
  await stopping
  detach()
  expect(landed).toEqual(["in the editor"])
  expect(composers.a.state.task.text).toBe("")
})

test("clients without the native bridge are unsupported", async () => {
  for (const response of [new Response("Not found", { status: 404 }), new Response("<html>", { headers: { "content-type": "text/html" } })]) {
    const voice = createDictation({ fetch: async () => response })
    await voice.refresh()
    expect(voice.state.availability).toBe("unsupported")
  }
})

test("a capture left running by a reloaded renderer is cancelled", async () => {
  const { net, voice } = setup({ available: true, state: "recording", id: "11111111-1111-4111-8111-111111111111" })
  await voice.refresh()
  expect(net.calls).toEqual([{ action: "cancel", id: "11111111-1111-4111-8111-111111111111" }])
})

test("dictated text is spaced against its neighbours", () => {
  const draft = (text: string, selection: [number, number], revision = 1) => ({ text, selection, revision })
  expect(dictationInsert(draft("", [0, 0]), { revision: 1, selection: [0, 0] }, " hi ")).toMatchObject({ text: "hi", caret: 2 })
  expect(dictationInsert(draft("ab", [1, 1]), { revision: 1, selection: [1, 1] }, "X")).toMatchObject({ text: "a X b", caret: 3 })
  expect(dictationInsert(draft("end.", [3, 3]), { revision: 1, selection: [3, 3] }, "X")).toMatchObject({ text: "end X.", caret: 5 })
  expect(dictationInsert(draft("a ", [2, 2]), { revision: 1, selection: [9, 9] }, "X")).toMatchObject({ text: "a X", caret: 3 })
  // Edited since capture: never replaces the (stale) captured selection.
  expect(dictationInsert(draft("new text", [8, 8], 2), { revision: 1, selection: [0, 3] }, "X")).toMatchObject({ text: "new text X", caret: 10 })
})

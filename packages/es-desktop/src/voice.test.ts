import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createTranscriber, createVoice, transcriptText, voiceTools, type VoiceTools } from "./voice"
import { serve } from "./server"
import { createBridge } from "./bridge"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// Stands in for SoX: writes a WAV-sized clip to the output argument, then records until SIGINT.
const fakeRecorder = `#!/bin/sh
for arg in "$@"; do case "$arg" in *.wav) out="$arg";; esac; done
head -c 3244 /dev/zero > "$out"
echo "$$" > "$(dirname "$0")/recorder.pid"
trap 'exit 0' INT
while :; do sleep 0.05; done
`
// Stands in for whisper-cli: honours -of and -otxt, optionally slowly.
const fakeTranscriber = (text: string, delay = 0) => `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -of) out="$2"; shift;; esac; shift; done
echo "$$" > "$(dirname "$0")/transcriber.pid"
sleep ${delay}
printf ${JSON.stringify(text)} > "$out.txt"
`

const setup = async (input: { transcript?: string; delay?: number; permission?: boolean } = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), "es-voice-test-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const tools: VoiceTools = {
    recorder: path.join(root, "sox"),
    transcriber: path.join(root, "whisper-cli"),
    model: path.join(root, "ggml-fixture.bin"),
  }
  await writeFile(tools.recorder, fakeRecorder)
  await writeFile(tools.transcriber, fakeTranscriber(input.transcript ?? " Hello there.\n And more.\n", input.delay))
  await writeFile(tools.model, "")
  await chmod(tools.recorder, 0o755)
  await chmod(tools.transcriber, 0o755)
  const temp = path.join(root, "tmp")
  await mkdir(temp)
  const voice = createVoice({ resolve: async () => tools, permission: async () => input.permission ?? true, temp })
  cleanup.push(voice.close)
  const alive = async (name: string) => {
    const pid = Number(await Bun.file(path.join(root, `${name}.pid`)).text().catch(() => "0"))
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  // Waits until the fake recorder is capturing, as a real stop follows audible speech.
  const recording = async () => {
    for (let i = 0; i < 200 && !(await alive("recorder")); i++) await Bun.sleep(10)
  }
  return { root, temp, voice, alive, recording }
}

const id = () => crypto.randomUUID()

test("records, stops and returns the joined transcript, deleting the clip", async () => {
  const { voice, temp, recording } = await setup()
  const run = id()
  expect(await voice.start(run)).toEqual({ ok: true })
  await recording()
  expect((await voice.status()).state).toBe("recording")
  expect(await readdir(temp)).toHaveLength(1)
  expect(await voice.stop(run)).toEqual({ ok: true, text: "Hello there. And more." })
  expect(await voice.status()).toEqual({ available: true, state: "idle" })
  expect(await readdir(temp)).toEqual([])
})

test("refuses a second dictation while one is active", async () => {
  const { voice } = await setup()
  const run = id()
  const [first, second] = await Promise.all([voice.start(run), voice.start(id())])
  expect(first).toEqual({ ok: true })
  expect(second).toMatchObject({ ok: false, code: "busy" })
  await voice.cancel(run)
})

test("cancel during recording kills the recorder, removes the clip and frees the slot", async () => {
  const { voice, temp, alive, recording } = await setup()
  const run = id()
  await voice.start(run)
  await recording()
  expect(await alive("recorder")).toBe(true)
  await voice.cancel(run)
  expect(await alive("recorder")).toBe(false)
  expect(await readdir(temp)).toEqual([])
  expect(await voice.stop(run)).toMatchObject({ ok: false, code: "inactive" })
  expect(await voice.start(id())).toEqual({ ok: true })
})

test("cancel during transcription kills the transcriber and the pending stop reports cancelled", async () => {
  const { voice, temp, alive, recording } = await setup({ delay: 5 })
  const run = id()
  await voice.start(run)
  await recording()
  const stopped = voice.stop(run)
  for (let i = 0; i < 100 && !(await alive("transcriber")); i++) await Bun.sleep(20)
  expect((await voice.status()).state).toBe("transcribing")
  await voice.cancel(run)
  expect(await stopped).toMatchObject({ ok: false, code: "cancelled" })
  expect(await alive("transcriber")).toBe(false)
  expect(await readdir(temp)).toEqual([])
})

test("cancel with another dictation id leaves the active one running", async () => {
  const { voice } = await setup()
  const run = id()
  await voice.start(run)
  await voice.cancel(id())
  expect((await voice.status()).state).toBe("recording")
  await voice.cancel(run)
})

test("blank audio is reported as no speech", async () => {
  const { voice, recording } = await setup({ transcript: " [BLANK_AUDIO]\n" })
  const run = id()
  await voice.start(run)
  await recording()
  expect(await voice.stop(run)).toMatchObject({ ok: false, code: "empty" })
})

test("a failing transcriber reports its stderr as detail and leaves nothing behind", async () => {
  const { root, voice, temp, recording } = await setup()
  await writeFile(path.join(root, "whisper-cli"), "#!/bin/sh\necho 'failed to load model' >&2\nexit 3\n")
  const run = id()
  await voice.start(run)
  await recording()
  expect(await voice.stop(run)).toEqual({
    ok: false,
    code: "failed",
    message: "Couldn't transcribe the recording",
    detail: "failed to load model",
  })
  expect(await readdir(temp)).toEqual([])
})

test("denied microphone access starts nothing", async () => {
  const { voice, temp, alive } = await setup({ permission: false })
  expect(await voice.start(id())).toMatchObject({ ok: false, code: "permission", message: "Couldn't record: microphone access denied" })
  expect(await alive("recorder")).toBe(false)
  expect(await readdir(temp)).toEqual([])
  expect((await voice.status()).state).toBe("idle")
})

test("missing setup is reported without starting", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "es-voice-test-"))
  cleanup.push(() => rm(temp, { recursive: true, force: true }))
  const voice = createVoice({
    resolve: async () => ({ missing: "model", message: "No Whisper model found." }),
    permission: async () => true,
    temp,
  })
  expect(await voice.status()).toEqual({ available: false, missing: "model", message: "No Whisper model found.", state: "idle" })
  expect(await voice.start(id())).toMatchObject({ ok: false, code: "unavailable", detail: "No Whisper model found." })
})

test("finds the bin/transcribe whisper.cpp checkout and prefers its model", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "es-voice-home-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const config = path.join(home, "voice.json")
  const recorder = path.join(home, "sox")
  await writeFile(recorder, "#!/bin/sh\n")
  await chmod(recorder, 0o755)
  await writeFile(config, JSON.stringify({ recorder }))
  expect(await voiceTools({ home, env: {}, config, system: [] })).toMatchObject({ missing: "transcriber" })
  await mkdir(path.join(home, "whisper.cpp/build/bin"), { recursive: true })
  await mkdir(path.join(home, "whisper.cpp/models"), { recursive: true })
  const cli = path.join(home, "whisper.cpp/build/bin/whisper-cli")
  await writeFile(cli, "#!/bin/sh\n")
  await chmod(cli, 0o755)
  expect(await voiceTools({ home, env: {}, config, system: [] })).toMatchObject({ missing: "model" })
  await writeFile(path.join(home, "whisper.cpp/models/ggml-base.en.bin"), "")
  await writeFile(path.join(home, "whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"), "")
  expect(await voiceTools({ home, env: {}, config, system: [] })).toEqual({
    recorder,
    transcriber: cli,
    model: path.join(home, "whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"),
  })
  // Relative overrides are ignored rather than resolved against the app's working directory.
  expect(await voiceTools({ home, env: { ES_VOICE_RECORDER: "sox" }, config: path.join(home, "none.json"), system: [] })).toMatchObject({
    missing: "recorder",
  })
})

test("transcript text joins segments and drops non-speech markers", () => {
  expect(transcriptText(" First segment.\n\n [BLANK_AUDIO]\n second  segment \n")).toBe("First segment. second segment")
})

test("the bridge is native-keyed, origin-bound and absent for paired listeners", async () => {
  const { voice, recording } = await setup()
  const root = await mkdtemp(path.join(tmpdir(), "es-voice-root-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>Fixture</title>")
  const server = await serve({ root, voice })
  cleanup.push(server.close)
  const post = (action: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.origin}/__es/voice/${action}`, {
      method: "POST",
      headers: { "x-editspace-key": server.key, origin: server.origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  expect((await fetch(`${server.origin}/__es/voice`)).status).toBe(403)
  const status = await fetch(`${server.origin}/__es/voice`, { headers: { "x-editspace-key": server.key } })
  expect(await status.json()).toEqual({ available: true, state: "idle" })
  expect((await post("start", { id: id() }, { origin: "http://127.0.0.1:1" })).status).toBe(403)
  expect((await post("start", { id: "../../etc" })).status).toBe(400)
  expect((await post("run", { id: id() })).status).toBe(404)
  const run = id()
  expect((await post("start", { id: run })).status).toBe(200)
  expect((await post("start", { id: id() })).status).toBe(409)
  await recording()
  const stopped = await post("stop", { id: run })
  expect(await stopped.json()).toEqual({ ok: true, text: "Hello there. And more." })
  expect((await post("cancel", { id: run })).status).toBe(200)

  const paired = await serve({ root, voice, host: "127.0.0.1", pairing: { code: "fixture-code-123456" } })
  cleanup.push(paired.close)
  expect((await fetch(`${paired.origin}/__es/voice`, { headers: { "x-editspace-key": paired.key } })).status).not.toBe(200)
})

test("remote host tabs get this machine's dictation, and only the starting tab sees its capture", async () => {
  const { voice, recording } = await setup()
  const root = await mkdtemp(path.join(tmpdir(), "es-voice-root-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>Fixture</title>")
  // The remote origin is never contacted for voice; it only needs to be a valid target.
  const local = await serve({ root, voice })
  const mini = await serve({ root, voice, remote: { id: "mini", origin: "http://127.0.0.1:9" } })
  cleanup.push(local.close, mini.close)
  const call = (server: typeof local, action?: string, body?: unknown) =>
    fetch(`${server.origin}/__es/voice${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET",
      headers: { "x-editspace-key": server.key, origin: server.origin, "content-type": "application/json" },
      body: action ? JSON.stringify(body) : undefined,
    })
  expect(await (await call(mini)).json()).toEqual({ available: true, state: "idle" })
  const run = id()
  expect((await call(mini, "start", { id: run })).status).toBe(200)
  await recording()
  // The local tab sees the shared microphone is busy, but not the id it could reload-cancel.
  expect(await (await call(local)).json()).toEqual({ available: true, state: "recording" })
  expect(await (await call(mini)).json()).toEqual({ available: true, state: "recording", id: run })
  expect((await call(local, "start", { id: id() })).status).toBe(409)
  expect(await (await call(mini, "stop", { id: run })).json()).toEqual({ ok: true, text: "Hello there. And more." })
})

test("a bridged Personal tab dictates with this machine's microphone and Whisper; only that tab can stop or cancel it", async () => {
  const { voice, recording } = await setup()
  const root = await mkdtemp(path.join(tmpdir(), "es-voice-root-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>Fixture</title>")
  // A bridged Personal host with no Access token: its gateway is never contacted, dictation stays on this machine.
  const bridge = createBridge({ origin: "https://personal.example", store: { access: async () => undefined, cookie: async () => undefined, saveCookie: async () => {}, forgetCookie: async () => {} } })
  await bridge.ready
  const work = await serve({ root, voice })
  const personal = await serve({ root, voice, remote: { id: "excalibur", origin: "https://personal.example", bridge } })
  cleanup.push(work.close, personal.close)
  const call = (server: typeof work, action?: string, body?: unknown) =>
    fetch(`${server.origin}/__es/voice${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET",
      headers: { "x-editspace-key": server.key, origin: server.origin, "content-type": "application/json" },
      body: action ? JSON.stringify(body) : undefined,
    })
  const run = id()
  expect((await call(personal, "start", { id: run })).status).toBe(200)
  await recording()
  // The Work tab, even knowing the id, can neither take the transcript nor cancel the Personal dictation.
  expect((await (await call(work, "stop", { id: run })).json()).code).toBe("inactive")
  expect((await call(work, "cancel", { id: run })).status).toBe(200)
  expect(await (await call(personal)).json()).toEqual({ available: true, state: "recording", id: run })
  expect(await (await call(personal, "stop", { id: run })).json()).toEqual({ ok: true, text: "Hello there. And more." })
})

// Real whisper.cpp over a synthesized private clip, when the local pipeline is installed. Capture
// stays a fixture: no test opens the microphone.
const real = await voiceTools({ home: process.env.HOME ?? "", env: process.env, config: "/nonexistent" })
test.skipIf("missing" in real || process.platform !== "darwin")("transcribes a private fixture clip with the installed whisper.cpp", async () => {
  if ("missing" in real) return
  const root = await mkdtemp(path.join(tmpdir(), "es-voice-real-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const clip = path.join(root, "fixture.wav")
  const said = Bun.spawnSync(["say", "-o", path.join(root, "fixture.aiff"), "Please rename the composer button."])
  expect(said.exitCode).toBe(0)
  const converted = Bun.spawnSync(["/opt/homebrew/bin/ffmpeg", "-loglevel", "error", "-i", path.join(root, "fixture.aiff"), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", clip])
  expect(converted.exitCode).toBe(0)
  const recorder = path.join(root, "sox")
  await writeFile(recorder, `#!/bin/sh\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\ncp ${JSON.stringify(clip)} "$out"\ntrap 'exit 0' INT\nwhile :; do sleep 0.05; done\n`)
  await chmod(recorder, 0o755)
  const temp = path.join(root, "tmp")
  await mkdir(temp)
  const voice = createVoice({ resolve: async () => ({ ...real, recorder }), permission: async () => true, temp })
  const run = id()
  await voice.start(run)
  // Stop only once the fixture clip is fully "recorded", as a person stops after speaking.
  const size = Bun.file(clip).size
  for (let i = 0; i < 200; i++) {
    const [dir] = await readdir(temp)
    if (dir && Bun.file(path.join(temp, dir, "clip.wav")).size === size) break
    await Bun.sleep(10)
  }
  const result = await voice.stop(run)
  expect(result).toMatchObject({ ok: true })
  if (result.ok) expect(result.text.toLowerCase()).toContain("composer")
}, 180_000)

// Stands in for SoX conversion: writes a 16 kHz mono clip of FAKE_MS milliseconds (32 bytes per ms + header).
const fakeConverter = (ms: number) => `#!/bin/sh
for arg in "$@"; do out="$arg"; done
case "$*" in *upload.*) ;; *) exit 2;; esac
head -c ${44 + ms * 32} /dev/zero > "$out"
`
// Stands in for whisper-cli -oj: honours -of, optionally slowly, and records that it saw -l auto.
const fakeJsonTranscriber = (segments: string[], delay = 0) => `#!/bin/sh
case "$*" in *"-l auto"*) ;; *) exit 3;; esac
while [ $# -gt 0 ]; do case "$1" in -of) out="$2"; shift;; esac; shift; done
echo "$$" > "$(dirname "$0")/transcriber.pid"
sleep ${delay}
printf '%s' ${JSON.stringify(JSON.stringify({ result: { language: "en" }, transcription: segments.map((text) => ({ text })) }))} > "$out.json"
`

const notes = async (input: { ms?: number; segments?: string[]; delay?: number; maxBytes?: number; converter?: string } = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), "es-voice-note-test-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const tools: VoiceTools = { recorder: path.join(root, input.converter ?? "sox"), transcriber: path.join(root, "whisper-cli"), model: path.join(root, "ggml-fixture.bin") }
  await writeFile(tools.recorder, fakeConverter(input.ms ?? 2_500))
  await writeFile(tools.transcriber, fakeJsonTranscriber(input.segments ?? [" Pick up milk.", " [BLANK_AUDIO]", " And eggs."], input.delay))
  await writeFile(tools.model, "")
  await chmod(tools.recorder, 0o755)
  await chmod(tools.transcriber, 0o755)
  const temp = path.join(root, "tmp")
  await mkdir(temp)
  const transcriber = createTranscriber({ resolve: async () => tools, temp, maxBytes: input.maxBytes })
  return { root, temp, transcriber }
}
const clip = (bytes = 4_000) => new Uint8Array(bytes)
const stream = async function* (data: Uint8Array) { yield data }

test("a voice note returns its text, detected language and duration, and leaves no files", async () => {
  const { temp, transcriber } = await notes()
  const result = await transcriber.transcribe({ type: "audio/wav", length: 4_000, body: stream(clip()), signal: new AbortController().signal })
  expect(result).toEqual({ ok: true, text: "Pick up milk. And eggs.", language: "en", duration_ms: 2_500 })
  expect(await readdir(temp)).toEqual([])
})

test("a voice note over the size limit, of another type or without a length is refused before any tool runs", async () => {
  const { root, transcriber } = await notes({ maxBytes: 1_000 })
  const signal = new AbortController().signal
  expect(await transcriber.transcribe({ type: "audio/wav", length: 2_000, body: stream(clip(2_000)), signal })).toMatchObject({ ok: false, code: "too-large" })
  expect(await transcriber.transcribe({ type: "audio/wav", length: 500, body: stream(clip(2_000)), signal })).toMatchObject({ ok: false, code: "too-large" })
  expect(await transcriber.transcribe({ type: "audio/mpeg", length: 500, body: stream(clip(500)), signal })).toMatchObject({ ok: false, code: "unsupported" })
  expect(await transcriber.transcribe({ type: "audio/ogg", body: stream(clip(500)), signal })).toMatchObject({ ok: false, code: "unsupported" })
  expect(await Bun.file(path.join(root, "transcriber.pid")).exists()).toBe(false)
})

test("a voice note longer than five minutes is refused after conversion", async () => {
  const { transcriber } = await notes({ ms: 300_001 })
  const result = await transcriber.transcribe({ type: "audio/ogg", length: 4_000, body: stream(clip()), signal: new AbortController().signal })
  expect(result).toMatchObject({ ok: false, code: "too-large" })
})

test("one voice note at a time; aborting the request kills whisper and frees the slot", async () => {
  const { root, temp, transcriber } = await notes({ delay: 5 })
  const abort = new AbortController()
  const first = transcriber.transcribe({ type: "audio/wav", length: 4_000, body: stream(clip()), signal: abort.signal })
  const pidFile = path.join(root, "transcriber.pid")
  for (let i = 0; i < 300 && !(await Bun.file(pidFile).exists()); i++) await Bun.sleep(10)
  expect(await transcriber.transcribe({ type: "audio/wav", length: 4_000, body: stream(clip()), signal: new AbortController().signal })).toMatchObject({ ok: false, code: "busy" })
  abort.abort()
  expect(await first).toMatchObject({ ok: false, code: "cancelled" })
  const pid = Number(await Bun.file(pidFile).text())
  expect(() => process.kill(pid, 0)).toThrow()
  expect(await readdir(temp)).toEqual([])
})

test("paired gateways expose transcription only to paired clients; the native listener's dictation stays native", async () => {
  const { transcriber } = await notes()
  const root = await mkdtemp(path.join(tmpdir(), "es-voice-root-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "index.html"), "<title>Fixture</title>")
  const gateway = await serve({ root, transcriber, host: "127.0.0.1", pairing: { code: "fixture-code-123456" } })
  cleanup.push(gateway.close)
  const upload = (headers: Record<string, string>) =>
    fetch(`${gateway.origin}/__es/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav", origin: gateway.origin, ...headers }, body: clip() })
  expect((await upload({})).status).toBe(401)
  const paired = await fetch(`${gateway.origin}/__es/pair`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: "fixture-code-123456" }) })
  const cookie = paired.headers.get("set-cookie")!.split(";")[0]!
  // A paired cookie from another page origin is refused like no cookie.
  expect((await upload({ cookie, origin: "http://127.0.0.1:1" })).status).toBe(401)
  const answer = await upload({ cookie })
  expect(answer.status).toBe(200)
  expect(await answer.json()).toEqual({ ok: true, text: "Pick up milk. And eggs.", language: "en", duration_ms: 2_500 })
  expect((await fetch(`${gateway.origin}/__es/voice/transcribe`, { headers: { cookie } })).status).toBe(405)
  // Dictation (this host's microphone) is still never offered to paired clients.
  expect((await fetch(`${gateway.origin}/__es/voice`, { headers: { cookie } })).status).toBe(404)
})

test("without SoX, afconvert converts wav notes and ogg is refused as unsupported", async () => {
  const { transcriber } = await notes({ converter: "afconvert" })
  const signal = new AbortController().signal
  expect(await transcriber.transcribe({ type: "audio/wav", length: 4_000, body: stream(clip()), signal })).toMatchObject({ ok: true, duration_ms: 2_500 })
  expect(await transcriber.transcribe({ type: "audio/ogg", length: 4_000, body: stream(clip()), signal })).toMatchObject({ ok: false, code: "unsupported" })
})

test("voice notes fall back to macOS afconvert when SoX is missing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "es-voice-home-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const bin = path.join(home, "bin")
  await mkdir(bin)
  await mkdir(path.join(home, ".local/share/whisper/models"), { recursive: true })
  for (const name of ["whisper-cli", "afconvert"]) {
    await writeFile(path.join(bin, name), "#!/bin/sh\n")
    await chmod(path.join(bin, name), 0o755)
  }
  await writeFile(path.join(home, ".local/share/whisper/models/ggml-large-v3-turbo.bin"), "")
  const input = { home, env: {}, config: path.join(home, "none.json"), system: [bin] }
  expect(await voiceTools(input)).toMatchObject({ missing: "recorder" })
  expect(await voiceTools({ ...input, fallback: [path.join(bin, "afconvert")] })).toEqual({
    recorder: path.join(bin, "afconvert"), transcriber: path.join(bin, "whisper-cli"), model: path.join(home, ".local/share/whisper/models/ggml-large-v3-turbo.bin"),
  })
})

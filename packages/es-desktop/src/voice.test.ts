import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createVoice, transcriptText, voiceTools, type VoiceTools } from "./voice"
import { serve } from "./server"

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
  expect(await voiceTools({ home, env: {}, config })).toMatchObject({ missing: "transcriber" })
  await mkdir(path.join(home, "whisper.cpp/build/bin"), { recursive: true })
  await mkdir(path.join(home, "whisper.cpp/models"), { recursive: true })
  const cli = path.join(home, "whisper.cpp/build/bin/whisper-cli")
  await writeFile(cli, "#!/bin/sh\n")
  await chmod(cli, 0o755)
  expect(await voiceTools({ home, env: {}, config })).toMatchObject({ missing: "model" })
  await writeFile(path.join(home, "whisper.cpp/models/ggml-base.en.bin"), "")
  await writeFile(path.join(home, "whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"), "")
  expect(await voiceTools({ home, env: {}, config })).toEqual({
    recorder,
    transcriber: cli,
    model: path.join(home, "whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"),
  })
  // Relative overrides are ignored rather than resolved against the app's working directory.
  expect(await voiceTools({ home, env: { ES_VOICE_RECORDER: "sox" }, config: path.join(home, "none.json") })).toMatchObject({
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
  const result = await voice.stop(run)
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.text.toLowerCase()).toContain("composer")
}, 180_000)

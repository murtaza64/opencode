import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { access, constants, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import path from "node:path"

/**
 * Operator dictation for the native shell: SoX records the default input device, then a local
 * whisper.cpp `whisper-cli` transcribes the clip (the same pipeline as dotfiles `bin/transcribe`).
 * Only the keyed native listener reaches this; it never runs arbitrary commands, uploads audio or
 * touches drafts. One capture or transcription runs at a time and its clip is always deleted.
 */
export type VoiceTools = { recorder: string; transcriber: string; model: string }
export type VoiceMissing = { missing: "recorder" | "transcriber" | "model"; message: string }
export type VoiceStatus = {
  available: boolean
  missing?: VoiceMissing["missing"]
  message?: string
  state: "idle" | "recording" | "transcribing"
  // Lets a reloaded renderer cancel a capture it can no longer deliver.
  id?: string
}
export type VoiceFailure = {
  ok: false
  code: "busy" | "unavailable" | "permission" | "inactive" | "cancelled" | "empty" | "failed" | "too-large" | "unsupported"
  message: string
  // Technical cause (tool stderr tail or setup step), folded behind Details in the UI.
  detail?: string
}
export type Voice = ReturnType<typeof createVoice>

export const createVoice = (options: {
  resolve: () => Promise<VoiceTools | VoiceMissing>
  // Resolves whether the OS allows microphone capture, prompting once when undetermined.
  permission: () => Promise<boolean>
  temp: string
  // Opens the OS microphone privacy settings; the only action besides capture.
  openSettings?: () => Promise<void>
  maxSeconds?: number
  transcribeTimeoutMs?: number
}) => {
  type Active = {
    id: string
    // The listener (host tab) that started it; only that renderer may adopt or reload-cancel it.
    owner?: string
    phase: "starting" | "recording" | "transcribing"
    cancelled: boolean
    dir?: string
    recorder?: ChildProcess
    recorded?: Promise<{ code: number | null; stderr: string }>
    transcriber?: ChildProcess
  }
  const holder: { active?: Active } = {}
  const fail = (code: VoiceFailure["code"], message: string, detail?: string): VoiceFailure => ({
    ok: false,
    code,
    message,
    ...(detail ? { detail: detail.trim().slice(-600) } : {}),
  })
  const finish = async (active: Active) => {
    if (holder.active === active) holder.active = undefined
    if (active.dir) await rm(active.dir, { recursive: true, force: true })
  }

  const status = async (owner?: string): Promise<VoiceStatus> => {
    const state = holder.active ? (holder.active.phase === "transcribing" ? "transcribing" : "recording") : "idle"
    const id = holder.active?.owner === owner ? holder.active?.id : undefined
    const tools = await options.resolve()
    if ("missing" in tools) return { available: false, missing: tools.missing, message: tools.message, state, id }
    return { available: true, state, id }
  }

  const start = async (id: string, owner?: string): Promise<{ ok: true } | VoiceFailure> => {
    if (holder.active) return fail("busy", "Dictation is already running.")
    const active: Active = { id, owner, phase: "starting", cancelled: false }
    holder.active = active
    const tools = await options.resolve().catch(() => undefined)
    if (!tools || "missing" in tools) {
      await finish(active)
      return fail("unavailable", "Couldn't record: dictation isn't set up", tools?.message ?? "Dictation setup could not be read.")
    }
    if (!(await options.permission().catch(() => false))) {
      await finish(active)
      return fail(
        "permission",
        "Couldn't record: microphone access denied",
        "Allow Editspace in System Settings › Privacy & Security › Microphone, then try again.",
      )
    }
    if (active.cancelled) {
      await finish(active)
      return fail("cancelled", "Dictation cancelled.")
    }
    active.dir = await mkdtemp(path.join(options.temp, "es-voice-"))
    const recorder = spawn(
      tools.recorder,
      // Default input device; 16 kHz mono 16-bit is what whisper.cpp expects. `trim` caps the clip length.
      ["-q", "-d", "-c", "1", "-r", "16000", "-b", "16", path.join(active.dir, "clip.wav"), "trim", "0", String(options.maxSeconds ?? 600)],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
    active.recorder = recorder
    active.recorded = collect(recorder)
    const started = await Promise.race([
      new Promise<boolean>((resolve) => recorder.once("spawn", () => resolve(true))),
      active.recorded.then(() => false),
    ])
    if (!started || active.cancelled) {
      recorder.kill("SIGKILL")
      const recorded = await active.recorded
      await finish(active)
      return active.cancelled
        ? fail("cancelled", "Dictation cancelled.")
        : fail("failed", "Couldn't record: the recorder didn't start", recorded.stderr || tools.recorder)
    }
    active.phase = "recording"
    return { ok: true }
  }

  const stop = async (id: string): Promise<{ ok: true; text: string } | VoiceFailure> => {
    const active = holder.active
    if (!active || active.id !== id || active.phase !== "recording" || !active.recorder || !active.recorded || !active.dir)
      return fail("inactive", "No recording to stop.")
    active.phase = "transcribing"
    // SIGINT lets SoX finish the WAV header, as `bin/transcribe` does.
    active.recorder.kill("SIGINT")
    const kill = setTimeout(() => active.recorder?.kill("SIGKILL"), 5_000)
    const recorded = await active.recorded
    clearTimeout(kill)
    const clip = path.join(active.dir, "clip.wav")
    try {
      if (active.cancelled) return fail("cancelled", "Dictation cancelled.")
      const size = await stat(clip).then((value) => value.size).catch(() => 0)
      // SIGINT exits SoX with a signal or status 0; anything else is a capture failure.
      if (recorded.code !== null && recorded.code !== 0) return fail("failed", recorderMessage(recorded.stderr), recorded.stderr)
      // A header-only clip means Stop came before any audio arrived.
      if (size <= 44) return fail("empty", "No speech detected.")
      const tools = await options.resolve()
      if ("missing" in tools) return fail("unavailable", "Couldn't transcribe: dictation isn't set up", tools.message)
      const out = path.join(active.dir, "transcript")
      const transcriber = spawn(tools.transcriber, ["-m", tools.model, "-f", clip, "-otxt", "-of", out, "-np", "-nt"], {
        stdio: ["ignore", "ignore", "pipe"],
      })
      active.transcriber = transcriber
      const timer = setTimeout(() => transcriber.kill("SIGKILL"), options.transcribeTimeoutMs ?? 5 * 60_000)
      const result = await collect(transcriber)
      clearTimeout(timer)
      if (active.cancelled) return fail("cancelled", "Dictation cancelled.")
      if (result.code !== 0)
        return fail("failed", "Couldn't transcribe the recording", result.stderr || `${path.basename(tools.transcriber)} exited with ${result.code}`)
      const text = transcriptText(await readFile(`${out}.txt`, "utf8").catch(() => ""))
      if (!text) return fail("empty", "No speech detected.")
      return { ok: true, text }
    } finally {
      await finish(active)
    }
  }

  const cancel = async (id: string) => {
    const active = holder.active
    if (!active || active.id !== id) return
    active.cancelled = true
    active.recorder?.kill("SIGKILL")
    active.transcriber?.kill("SIGKILL")
    // A pending stop() still owns cleanup and reports the cancellation.
    if (active.phase === "transcribing") return
    await active.recorded
    await finish(active)
  }

  return {
    status,
    start,
    stop,
    cancel,
    settings: async () => {
      if (!options.openSettings) return false
      await options.openSettings()
      return true
    },
    close: async () => {
      if (holder.active) await cancel(holder.active.id)
    },
  }
}

export type Transcription = { ok: true; text: string; language: string; duration_ms: number }
const AUDIO_TYPES: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg" }

/**
 * Voice-note transcription for paired phones (android-ops VOICE-NOTES.md): an uploaded wav or ogg clip, at most
 * `maxBytes` and `maxSeconds`, is converted by SoX to 16 kHz mono and transcribed by whisper-cli with language
 * detection. One clip at a time on this host; aborting the request kills the tools. The upload, the converted clip
 * and the transcript are deleted before the answer is returned; nothing about the audio is kept or logged.
 */
export const createTranscriber = (options: {
  resolve: () => Promise<VoiceTools | VoiceMissing>
  temp: string
  maxBytes?: number
  maxSeconds?: number
  timeoutMs?: number
}) => {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  const maxSeconds = options.maxSeconds ?? 300
  const state = { busy: false }
  const fail = (code: VoiceFailure["code"], message: string, detail?: string): VoiceFailure => ({
    ok: false,
    code,
    message,
    ...(detail ? { detail: detail.trim().slice(-600) } : {}),
  })
  const run = async (file: string, args: string[], signal: AbortSignal) => {
    const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] })
    const kill = () => child.kill("SIGKILL")
    signal.addEventListener("abort", kill, { once: true })
    const timer = setTimeout(kill, options.timeoutMs ?? 5 * 60_000)
    const result = await collect(child)
    clearTimeout(timer)
    signal.removeEventListener("abort", kill)
    return result
  }

  const transcribe = async (input: { type?: string; length?: number; body: AsyncIterable<Uint8Array>; signal: AbortSignal }): Promise<Transcription | VoiceFailure> => {
    const extension = AUDIO_TYPES[(input.type ?? "").split(";")[0]!.trim().toLowerCase()]
    if (!extension) return fail("unsupported", "Send a wav or ogg clip.")
    if (input.length === undefined || !Number.isFinite(input.length)) return fail("unsupported", "Content-Length is required.")
    if (input.length > maxBytes) return fail("too-large", `The clip is over ${Math.round(maxBytes / 1024 / 1024)} MB.`)
    if (state.busy) return fail("busy", "Another voice note is being transcribed.")
    state.busy = true
    const dir = await mkdtemp(path.join(options.temp, "es-voice-note-"))
    try {
      const tools = await options.resolve()
      if ("missing" in tools) return fail("unavailable", "Couldn't transcribe: voice notes aren't set up", tools.message)
      const upload = path.join(dir, `upload.${extension}`)
      const counted = async function* () {
        let size = 0
        for await (const chunk of input.body) {
          size += chunk.length
          if (size > maxBytes || size > input.length!) throw new RangeError("too large")
          yield chunk
        }
      }
      const received = await pipeline(counted(), createWriteStream(upload, { mode: 0o600 }), { signal: input.signal }).then(
        () => "ok" as const,
        (error: unknown) => (error instanceof RangeError ? ("too-large" as const) : ("aborted" as const)),
      )
      if (received === "too-large") return fail("too-large", `The clip is over ${Math.round(maxBytes / 1024 / 1024)} MB.`)
      if (received === "aborted" || input.signal.aborted) return fail("cancelled", "Transcription cancelled.")
      const clip = path.join(dir, "clip.wav")
      // SoX reads wav and ogg; macOS afconvert (the fallback without SoX) reads wav but not ogg.
      const afconvert = path.basename(tools.recorder) === "afconvert"
      if (afconvert && extension === "ogg") return fail("unsupported", "This host can only read wav clips (ogg needs SoX).")
      const converted = await run(tools.recorder, afconvert
        ? ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", upload, clip]
        : ["-q", upload, "-c", "1", "-r", "16000", "-b", "16", clip], input.signal)
      if (input.signal.aborted) return fail("cancelled", "Transcription cancelled.")
      if (converted.code !== 0) return fail("failed", "Couldn't read the clip", converted.stderr)
      // 16 kHz mono 16-bit after conversion: 32 bytes per millisecond after the 44-byte header.
      const duration = Math.max(0, Math.round(((await stat(clip)).size - 44) / 32))
      if (duration > maxSeconds * 1000) return fail("too-large", `The clip is over ${Math.round(maxSeconds / 60)} minutes.`)
      if (duration === 0) return fail("empty", "No speech detected.")
      const out = path.join(dir, "transcript")
      const result = await run(tools.transcriber, ["-m", tools.model, "-f", clip, "-l", "auto", "-oj", "-of", out, "-np", "-nt"], input.signal)
      if (input.signal.aborted) return fail("cancelled", "Transcription cancelled.")
      if (result.code !== 0) return fail("failed", "Couldn't transcribe the clip", result.stderr || `${path.basename(tools.transcriber)} exited with ${result.code}`)
      const json = await readFile(`${out}.json`, "utf8").then((value): unknown => JSON.parse(value)).catch(() => undefined)
      const parsed = json && typeof json === "object" ? (json as { result?: { language?: unknown }; transcription?: { text?: unknown }[] }) : {}
      const text = transcriptText((parsed.transcription ?? []).map((segment) => (typeof segment?.text === "string" ? segment.text : "")).join("\n"))
      if (!text) return fail("empty", "No speech detected.")
      return { ok: true, text, language: typeof parsed.result?.language === "string" ? parsed.result.language : "unknown", duration_ms: duration }
    } finally {
      await rm(dir, { recursive: true, force: true })
      state.busy = false
    }
  }

  return { transcribe }
}
export type Transcriber = ReturnType<typeof createTranscriber>

/** Finds the existing pipeline: explicit overrides, then Homebrew and the `~/whisper.cpp` checkout `bin/transcribe` uses. */
export const voiceTools = async (input: {
  home: string
  env: Record<string, string | undefined>
  config: string
  // Package-manager bin directories searched after overrides and ~/whisper.cpp.
  system?: string[]
  // Converters accepted in place of SoX when there is no SoX (voice notes convert uploads; they never record).
  fallback?: string[]
}): Promise<VoiceTools | VoiceMissing> => {
  const system = input.system ?? ["/opt/homebrew/bin", "/usr/local/bin"]
  const saved = await readFile(input.config, "utf8")
    .then((value): unknown => JSON.parse(value))
    .catch(() => undefined)
  const config = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {}
  const configured = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : undefined)
  const models = path.join(input.home, "whisper.cpp/models")
  const recorder = await first(
    [input.env.ES_VOICE_RECORDER, configured("recorder"), ...system.map((dir) => path.join(dir, "sox")), ...(input.fallback ?? [])],
    executable,
  )
  if (!recorder) return { missing: "recorder", message: "SoX is not installed. Install it with: brew install sox" }
  const transcriber = await first(
    [
      input.env.ES_VOICE_TRANSCRIBER,
      configured("transcriber"),
      path.join(input.home, "whisper.cpp/build/bin/whisper-cli"),
      ...system.map((dir) => path.join(dir, "whisper-cli")),
    ],
    executable,
  )
  if (!transcriber)
    return { missing: "transcriber", message: "whisper.cpp is not installed. Install it with: brew install whisper-cpp" }
  // ~/whisper.cpp/models (bin/transcribe), then the shared model directory mac-mini-setup installs into.
  const shared = path.join(input.home, ".local/share/whisper/models")
  const found = [
    ...(await readdir(models).catch(() => [])).map((name) => path.join(models, name)),
    ...(await readdir(shared).catch(() => [])).map((name) => path.join(shared, name)),
  ]
  const model = await first(
    [
      input.env.ES_VOICE_MODEL,
      configured("model"),
      ...found
        .filter((file) => /^ggml-.+\.bin$/.test(path.basename(file)))
        // Prefer the model `bin/transcribe` uses, then any large-v3-turbo variant; ~/whisper.cpp wins ties.
        .sort((a, b) => modelRank(path.basename(a)) - modelRank(path.basename(b)) ||
          Number(path.dirname(a) !== models) - Number(path.dirname(b) !== models) || path.basename(a).localeCompare(path.basename(b))),
    ],
    async (file) => stat(file).then((value) => value.isFile()).catch(() => false),
  )
  if (!model) return { missing: "model", message: "No Whisper model found. Add a ggml model to ~/whisper.cpp/models or ~/.local/share/whisper/models." }
  return { recorder, transcriber, model }
}

const modelRank = (name: string) =>
  name === "ggml-large-v3-turbo.bin" ? 0 : name.startsWith("ggml-large-v3-turbo") ? 1 : 2

const executable = (file: string) =>
  access(file, constants.X_OK)
    .then(() => stat(file))
    .then((value) => value.isFile())
    .catch(() => false)

const first = async (candidates: (string | undefined)[], check: (file: string) => Promise<boolean>) => {
  for (const file of candidates) if (file && path.isAbsolute(file) && (await check(file))) return file
  return undefined
}

const collect = (child: ChildProcess) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const chunks: string[] = []
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      if (chunks.join("").length < 4096) chunks.push(chunk)
    })
    child.once("error", () => resolve({ code: -1, stderr: chunks.join("") }))
    // `exit`, not `close`: a killed process's orphaned descendants can hold stderr open.
    child.once("exit", (code) => resolve({ code, stderr: chunks.join("") }))
  })

/** Joins whisper.cpp segments into one paragraph and drops its non-speech markers. */
export const transcriptText = (raw: string) =>
  raw
    .replace(/\[(BLANK_AUDIO|SILENCE|NO_SPEECH)\]/gi, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

const recorderMessage = (stderr: string) =>
  /no default audio device|can't open input|coreaudio/i.test(stderr)
    ? "Couldn't record: no microphone input"
    : "Couldn't record"

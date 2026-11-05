// Long dictation must not end in one sentence repeated (DD keyboard-workflow#72). Synthetic speech only: macOS `say`
// reads a fixed text, then the clip gets 40 s of quiet room noise, as when someone pauses before pressing Stop. Runs the
// installed whisper-cli and model with this package's DECODE options, and once without them to show the bug (red).
// macOS only; needs whisper-cli and a ggml model (ES_VOICE_MODEL or the voiceTools search). Heavy: ask Perf first.
// Run from packages/es-desktop: bun test/voice-repetition.real.mjs
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import path from "node:path"
import { DECODE, voiceTools } from "../src/voice"

const TEXT = `This morning I want to walk through the plan for the release and the open questions that are still blocking it. First, the desktop build needs one more pass on the keyboard flow, because the help overlay and the Porter shortcut only landed yesterday. Second, the phone client still drops the connection when the laptop sleeps, and we have not decided whether the gateway should retry or simply tell the person what happened. Third, there is the question of dictation, which has become one of the most useful parts of the app, but it occasionally produces strange output on long recordings.
For the release itself, I would like the notes to say what changed in plain language, without any marketing. Each item should be one or two sentences, and anything that needs a decision should be called out separately so that nobody has to read the whole list to find it. If a change is risky, we should say how to undo it, and we should name the person who will watch the first day of usage.
On the phone side, the simplest option is to show a quiet banner when the connection drops and to reconnect in the background. The more ambitious option is to keep a small queue of messages on the phone and send them once the laptop wakes up. I lean toward the simple option for now, because the queue raises questions about ordering and duplicates that we have not thought through.
Finally, for dictation, I want to understand whether the problem is in how we capture the audio or in how the model decodes it. If it is the model, there are a few settings we can try, and if it is the capture, we should be able to reproduce it with a synthetic recording. Either way, I do not want to delete repeated words blindly, because sometimes repetition is intentional, and the person should always see exactly what they said.`

const tools = await voiceTools({ home: homedir(), env: process.env, config: path.join(tmpdir(), "no-voice-config.json"), fallback: ["/usr/bin/afconvert"] })
if ("missing" in tools) throw new Error(`voice tools missing: ${tools.message}`)
const dir = await mkdtemp(path.join(tmpdir(), "es-voice-repetition-"))
try {
  execFileSync("say", ["-v", "Samantha", "-r", "175", "-o", path.join(dir, "speech.aiff"), TEXT])
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path.join(dir, "speech.aiff"), path.join(dir, "speech.wav")])
  const speech = await readFile(path.join(dir, "speech.wav"))
  // afconvert pads its header (FLLR chunk): read the samples from the "data" chunk.
  const data = speech.indexOf("data")
  const pcm = speech.subarray(data + 8, data + 8 + speech.readUInt32LE(data + 4))
  // Deterministic low-level pink-ish noise: the room between the last word and Stop.
  const noise = Buffer.alloc(16000 * 40 * 2)
  let seed = 1, level = 0
  for (let i = 0; i < noise.length; i += 2) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    level = 0.97 * level + ((seed / 2 ** 31) * 2 - 1) * 18
    noise.writeInt16LE(Math.round(level), i)
  }
  // About 5 minutes of speech (the text three times), then the noise: many 30 s windows carry text over, and the
  // last ones hear no speech. This shape reproduced the loop on large-v3-turbo without DECODE (7x and 5x).
  const body = Buffer.concat([pcm, pcm, pcm, noise])
  const header = Buffer.alloc(44)
  header.write("RIFF", 0); header.writeUInt32LE(36 + body.length, 4); header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write("data", 36); header.writeUInt32LE(body.length, 40)
  const clip = path.join(dir, "clip.wav")
  await writeFile(clip, Buffer.concat([header, body]))
  const decode = async (extra, name) => {
    execFileSync(tools.transcriber, ["-m", tools.model, "-f", clip, ...extra, "-otxt", "-of", path.join(dir, name), "-np", "-nt"], { stdio: "ignore" })
    return readFile(path.join(dir, `${name}.txt`), "utf8")
  }
  const loop = (text) => {
    const sentences = text.split(/(?<=[.!?])\s+|\n/).map((s) => s.toLowerCase().replace(/[^a-z ]/g, "").trim()).filter((s) => s.split(" ").length >= 3)
    return sentences.reduce((best, s, i) => { let n = 1; while (sentences[i + n] === s) n++; return Math.max(best, n) }, 0)
  }
  const [withText, withoutText] = [await decode(DECODE, "shipped"), await decode([], "carried")]
  if (withText.split(/\s+/).length < 600) throw new Error(`FAIL: transcript too short (${withText.split(/\s+/).length} words)`)
  const shipped = loop(withText)
  const carried = loop(withoutText)
  console.log(`longest run of one repeated sentence: with DECODE ${shipped}, without ${carried}; words ${withText.split(/\s+/).length}/${withoutText.split(/\s+/).length}`)
  if (shipped >= 3) throw new Error(`FAIL: with DECODE one sentence repeats ${shipped} times in a row`)
  console.log(`PASS voice repetition: no sentence loop with ${DECODE.join(" ")}${carried >= 3 ? `; without it the loop reproduces (${carried}x)` : "; without it this run did not loop (model-dependent)"}`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

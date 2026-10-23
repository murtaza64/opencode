// Native dictation end to end in a hidden, disposable Electron profile. Capture and transcription
// are fixture executables: no microphone, model, prompt or upload.
import { _electron, expect } from "@playwright/test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-voice-native-"))
const tools = await mkdtemp(path.join(tmpdir(), "es-voice-tools-"))
await writeFile(path.join(tools, "sox"), `#!/bin/sh
for arg in "$@"; do case "$arg" in *.wav) out="$arg";; esac; done
head -c 3244 /dev/zero > "$out"
echo "$$" > "${tools}/recorder.pid"
trap 'exit 0' INT
while :; do sleep 0.05; done
`)
await writeFile(path.join(tools, "whisper-cli"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -of) out="$2"; shift;; esac; shift; done
echo "$$" > "${tools}/transcriber.pid"
sleep "$(cat "${tools}/delay")"
if [ -s "${tools}/fail" ]; then cat "${tools}/fail" >&2; exit 1; fi
cat "${tools}/text" > "$out.txt"
`)
await writeFile(path.join(tools, "ggml-fixture.bin"), "")
await chmod(path.join(tools, "sox"), 0o755)
await chmod(path.join(tools, "whisper-cli"), 0o755)
const script = async (text, delay = 0, fail = "") => {
  await writeFile(path.join(tools, "text"), text)
  await writeFile(path.join(tools, "delay"), String(delay))
  await writeFile(path.join(tools, "fail"), fail)
}
const alive = async (name) => {
  const pid = Number(await readFile(path.join(tools, `${name}.pid`), "utf8").catch(() => "0"))
  try {
    return pid > 0 && process.kill(pid, 0)
  } catch {
    return false
  }
}
const app = await _electron.launch({
  // ES_DESKTOP_EXECUTABLE runs the packaged app (electron-builder --dir output) instead of the source tree.
  executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  args: process.env.ES_DESKTOP_EXECUTABLE ? [] : [path.resolve(import.meta.dirname, "..")],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    ES_DESKTOP_START: "hidden",
    ES_DESKTOP_USER_DATA: profile,
    ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url,
    ES_DASHBOARD_URL: fixture.url,
    OPENCODE_SERVER_PASSWORD: "",
    ES_VOICE_RECORDER: path.join(tools, "sox"),
    ES_VOICE_TRANSCRIBER: path.join(tools, "whisper-cli"),
    ES_VOICE_MODEL: path.join(tools, "ggml-fixture.bin"),
  },
})
const pass = (text) => console.info(`PASS ${text}`)
const shots = process.argv.includes("--screenshot") ? path.join(import.meta.dirname, "..", "artifacts") : undefined
let page
const shot = async (name) => {
  if (shots) await page.locator(".direct-composer").screenshot({ path: path.join(shots, `voice-${name}.png`) })
}
try {
  page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  const go = (id) => page.goto(`${origin}/session/${id}?directory=${encodeURIComponent(directory)}`)
  // In-app navigation, as a sidebar click does; page.goto would reload the renderer.
  const navigate = (id) =>
    page.evaluate((url) => {
      history.pushState(null, "", url)
      dispatchEvent(new PopStateEvent("popstate"))
    }, `/session/${id}?directory=${encodeURIComponent(directory)}`)
  const editor = () => page.getByRole("textbox", { name: "Message", exact: true })
  const toggle = () => page.locator(".dictation-toggle")
  const saved = (id) =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null")?.task?.text, `es-app:composer:1:${JSON.stringify([id, directory])}`)
  // The attention operator bootstrap is the app's own background write, not a submission.
  const writes = () => fixture.calls.filter((call) => call.method !== "GET" && !String(call.path ?? call.url).includes("/api/attention/session"))

  const status = () => page.locator(".dictation-status")
  const feedback = () => page.locator(".dictation-feedback")
  const focused = () => editor().evaluate((element) => document.activeElement === element)
  const caret = () => editor().evaluate((element) => [element.selectionStart, element.selectionEnd])
  const record = async () => {
    await expect(toggle()).toHaveAttribute("aria-label", "Stop dictation and transcribe")
    await expect.poll(() => alive("recorder")).toBe(true)
  }

  await go("ses_a")
  await editor().fill("Please the parser.")
  await editor().evaluate((element) => element.setSelectionRange(7, 7))
  await script("fix")
  await shot("idle")
  await toggle().click()
  await record()
  await expect(status()).toHaveText(/^0:0\d$/)
  await page.waitForTimeout(1200)
  await shot("recording")
  await toggle().click()
  await expect(editor()).toHaveValue("Please fix the parser.")
  expect(await caret()).toEqual([10, 10])
  expect(await focused()).toBe(true)
  await expect(toggle()).toHaveAttribute("aria-label", "Dictate")
  await expect(status()).toHaveText("")
  expect(await alive("recorder")).toBe(false)
  await editor().press("Meta+z")
  await expect(editor()).toHaveValue("Please the parser.")
  await editor().press("Meta+Shift+z")
  await expect(editor()).toHaveValue("Please fix the parser.")
  expect(writes()).toEqual([])
  pass("button: record, stop, inserted at the caret as one native undo step; focus kept; nothing sent")

  await editor().evaluate((element) => element.setSelectionRange(10, 10))
  await script("and add a test", 1.5)
  await editor().press("Meta+Shift+Space")
  await record()
  await navigate("ses_b")
  await expect(status()).toHaveText(/^Recording elsewhere 0:0\d$/)
  await shot("recording-elsewhere")
  await navigate("ses_a")
  await editor().focus()
  await editor().press("Meta+Shift+Space")
  await expect(status()).toHaveText("Transcribing…")
  await navigate("ses_b")
  await expect(page).toHaveURL(/ses_b/)
  await editor().fill("unrelated draft")
  await expect(toggle()).toBeDisabled()
  await expect(toggle()).toHaveAttribute("title", "Dictating in another conversation")
  await expect.poll(() => saved("ses_a"), { timeout: 10_000 }).toBe("Please fix and add a test the parser.")
  await expect(editor()).toHaveValue("unrelated draft")
  expect(await focused()).toBe(true)
  expect(writes()).toEqual([])
  pass("shortcut: other composers show the live recording; text lands in the original conversation's saved draft after navigating away; other draft and focus untouched")

  await navigate("ses_a")
  await expect(editor()).toHaveValue("Please fix and add a test the parser.")
  await editor().focus()
  await script("discard me", 5)
  await editor().press("Meta+Shift+Space")
  await record()
  await editor().press("Escape")
  await expect(toggle()).toHaveAttribute("aria-label", "Dictate")
  await expect(editor()).toHaveClass(/vim-insert/)
  expect(await alive("recorder")).toBe(false)
  await editor().press("Meta+Shift+Space")
  await record()
  await editor().press("Meta+Shift+Space")
  await expect.poll(() => alive("transcriber")).toBe(true)
  await shot("transcribing")
  await editor().press("Escape")
  await expect(toggle()).toHaveAttribute("aria-label", "Dictate")
  await expect.poll(() => alive("transcriber")).toBe(false)
  await expect(editor()).toHaveClass(/vim-insert/)
  await page.waitForTimeout(500)
  await expect(editor()).toHaveValue("Please fix and add a test the parser.")
  pass("Esc cancels recording and transcription (killing the owned process) without changing Vim mode or the draft")

  await editor().press("Escape")
  await expect(editor()).toHaveClass(/vim-normal/)
  await editor().evaluate((element) => element.setSelectionRange(0, 1))
  await script("Now")
  await editor().press("Meta+Shift+Space")
  await record()
  await editor().press("Meta+Shift+Space")
  await expect(editor()).toHaveValue("Now Please fix and add a test the parser.")
  await expect(editor()).toHaveClass(/vim-normal/)
  await editor().press("u")
  await expect(editor()).toHaveValue("Please fix and add a test the parser.")
  await editor().press("i")
  pass("Vim normal mode: shortcut works, inserts at the block caret, mode unchanged, one `u` removes it")

  await script("", 0, "whisper_init_from_file: failed to load model")
  await toggle().click()
  await record()
  await toggle().click()
  await expect(feedback()).toContainText("Couldn't transcribe the recording")
  await feedback().getByText("Details").click()
  await expect(feedback().locator("pre")).toHaveText("whisper_init_from_file: failed to load model")
  await expect(feedback().getByRole("button", { name: "Try again" })).toBeVisible()
  await shot("error")
  await script("")
  await feedback().getByRole("button", { name: "Try again" }).click()
  await expect(feedback()).toHaveCount(0)
  await record()
  await toggle().click()
  await expect(feedback()).toContainText("No speech detected.")
  await expect(feedback().getByRole("button", { name: "Try again" })).toHaveCount(0)
  await feedback().getByRole("button", { name: "Dismiss dictation error" }).click()
  await expect(feedback()).toHaveCount(0)
  await expect(editor()).toHaveValue("Please fix and add a test the parser.")
  pass("failure shows a line with Details and Try again, cleared by the next attempt; no speech offers no retry")

  if (shots) {
    await page.setViewportSize({ width: 390, height: 760 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await toggle().click()
    await record()
    await page.waitForTimeout(1100)
    await shot("rtl-390-recording")
    await page.keyboard.press("Escape")
    await page.evaluate(() => { document.documentElement.dir = "ltr" })
  }
} finally {
  await app.close()
  await fixture.close()
  await rm(profile, { recursive: true, force: true })
  await rm(tools, { recursive: true, force: true })
}

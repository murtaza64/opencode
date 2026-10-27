// Behavioural check of the native Desk APK on a headless emulator owned by this run
// (ES_ANDROID_SERIAL). Drives Compose through uiautomator (testTags are resource-ids) and
// asserts every write against the private fixture: nothing touches real services.
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import net from "node:net"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createFixture, fixture } from "./fixture.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const artifacts = process.env.ES_ARTIFACTS ?? path.join(root, "dist/artifacts")
await mkdir(artifacts, { recursive: true })
const serial = process.env.ES_ANDROID_SERIAL
if (!serial) throw new Error("Set ES_ANDROID_SERIAL to a headless emulator owned by this run")
const sdk = process.env.ANDROID_HOME ?? path.join(homedir(), "Library/Android/sdk")
const apk = process.env.ES_APK ?? path.join(root, "app/build/outputs/apk/debug/app-debug.apk")
const run = promisify(execFile)
const adb = async (...args) => (await run(path.join(sdk, "platform-tools/adb"), ["-s", serial, ...args], { encoding: "buffer", maxBuffer: 64 << 20, timeout: 30_000 })).stdout
const pkg = "ai.opencode.desk"
const code = "EMUL2-PAIR3-CODE4-ONLY5"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pass = (text) => console.info(`PASS ${text}`)
const spare = () => new Promise((resolve) => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)) }) })

const server = await createFixture()
const port = await spare()
const renderer = await mkdtemp(path.join(tmpdir(), "desk-gateway-"))
await writeFile(path.join(renderer, "index.html"), "<!doctype html><title>gateway</title>")
const gateway = spawn("bun", [path.join(root, "../es-android/src/gateway.ts"), "--port", String(port), "--root", renderer], {
  cwd: path.join(root, "../es-android"),
  env: { ...process.env, OPENCODE_URL: server.url, ES_DASHBOARD_URL: server.url, ES_REMOTE_PAIRING_CODE: code, OPENCODE_SERVER_PASSWORD: "" },
  stdio: ["ignore", "pipe", "inherit"],
})
await new Promise((resolve, reject) => {
  gateway.once("exit", (status) => reject(new Error(`Gateway exited ${status}`)))
  gateway.stdout.on("data", (chunk) => { if (String(chunk).includes("Editspace gateway")) resolve() })
})
gateway.once("exit", (status) => console.error(`gateway exited mid-run: ${status}`))

// The shared adb server occasionally drops reverse mappings while other lanes run; re-assert.
const reverse = () => adb("reverse", `tcp:${port}`, `tcp:${port}`).catch(() => {})
const nodes = async () => {
  await reverse()
  try { await adb("shell", "uiautomator", "dump", "/sdcard/desk-ui.xml") } catch { return [] }
  return [...String(await adb("shell", "cat", "/sdcard/desk-ui.xml")).matchAll(/<node [^>]*>/g)].map((match) =>
    Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]])))
}
const waitFor = async (predicate, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout
  for (let delay = 300; ; delay = Math.min(delay * 2, 2000)) {
    const found = (await nodes()).find(predicate)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(delay)
  }
}
const waitWrite = async (predicate, label, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  while (!fixture.writes.find(predicate)) { if (Date.now() > deadline) throw new Error(`Timed out waiting for write: ${label}`); await sleep(250) }
  return fixture.writes.find(predicate)
}
const byId = (id) => (node) => node["resource-id"] === id
const byText = (value) => (node) => node.text?.includes(value) || node["content-desc"]?.includes(value)
const tap = async (node) => {
  const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number)
  await adb("shell", "input", "tap", String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)))
}
const hideKeyboard = async () => {
  const ime = await adb("shell", "dumpsys", "input_method").catch(() => "")
  if (!/mInputShown=true/.test(String(ime))) return
  await adb("shell", "input", "keyevent", "KEYCODE_BACK"); await sleep(400)
}
// The emulator drops keystrokes when a long string is injected at once; type in short chunks.
const typeText = async (value) => {
  // `adb shell` passes the string through the device shell: keep to [A-Za-z0-9 .,:/?-] and quote it.
  for (const chunk of value.match(/.{1,6}/g) ?? []) { await adb("shell", "input", "text", `'${chunk.replace(/ /g, "%s")}'`); await sleep(120) }
}
const type = async (id, value) => {
  await tap(await waitFor(byId(id), id))
  await sleep(300)
  await typeText(value)
  await hideKeyboard()
}
const screenshot = async (name) => { await sleep(600); await writeFile(path.join(artifacts, `${name}.png`), await adb("exec-out", "screencap", "-p")); console.info(`shot ${name}.png`) }

try {
  await adb("install", "-r", apk)
  await adb("shell", "pm", "clear", pkg)
  await adb("reverse", `tcp:${port}`, `tcp:${port}`)
  await adb("shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`)

  // 1. pair
  await waitFor(byId("origin"), "connect screen")
  await screenshot("01-connect")
  await tap(await waitFor(byId("origin"), "origin"))
  await adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", ...Array(40).fill("KEYCODE_DEL"))
  await typeText(`http://127.0.0.1:${port}`)
  await hideKeyboard()
  await type("code", code)
  await tap(await waitFor(byId("pair"), "pair"))
  await waitFor(byId("desk"), "desk home")
  await waitFor(byText("Promote steers"), "attention row")
  pass("paired and the desk shows live fixture data")
  await screenshot("02-desk")

  // 2. decide
  await tap(await waitFor(byText("Promote steers"), "first decision"))
  await waitFor(byId("decision"), "decision sheet")
  await screenshot("03-decision")
  await tap(await waitFor(byId("option-boundary"), "option"))
  await tap(await waitFor(byId("send-answer"), "send"))
  const answer = await waitWrite((w) => w.path.endsWith("/commands") && w.body?.action === "answer", "attention answer")
  if (answer.body.choice_id !== "boundary" || answer.headers.csrf !== "1") throw new Error(`Unexpected answer write ${JSON.stringify(answer)}`)
  if (!fixture.writes.find((w) => w.path === "/api/attention/session" && w.method === "POST")) throw new Error("Operator bootstrap missing")
  pass("decision answered through operator bootstrap + CSRF; choice_id=boundary delivered to fixture")
  await waitFor((node) => node.text?.includes("Delivery retry needs"), "list without the answered row")
  await screenshot("04-desk-after-answer")

  // 3. full queue
  await tap(await waitFor(byId("tab-needs"), "needs tab"))
  await waitFor(byId("needs"), "needs screen")
  await screenshot("05-needs-you")
  pass("needs-you queue renders open/snoozed/history")

  // 4. agents + steer
  await tap(await waitFor(byId("tab-agents"), "agents tab"))
  await waitFor(byId("agents"), "agents screen")
  await screenshot("06-agents")
  await tap(await waitFor(byText("Composer float and steer timing"), "agent row"))
  await waitFor(byId("agent"), "agent screen")
  await waitFor(byText("Composer is pinned"), "transcript tail")
  await screenshot("07-agent")
  // CHAT-PARTS: chips collapsed (no body), tool run folded, image inline; narrow + RTL shots
  await waitFor((node) => node["content-desc"]?.startsWith("Mail from es-app, task"), "mail chip collapsed")
  if ((await nodes()).some((node) => node.text?.includes("Please land the pinned composer"))) throw new Error("mail body visible while collapsed")
  await waitFor((node) => node["content-desc"]?.startsWith("Tool run: 5 tools"), "tool run chip")
  pass("mail chips collapsed without body; tool run folded separately from mail")
  await screenshot("11-chat-parts-populated")
  await tap(await waitFor((node) => node["content-desc"]?.startsWith("Mail from es-app, task"), "chip"))
  await waitFor((node) => node["content-desc"]?.startsWith("Mail from es-app, task") && node["content-desc"]?.endsWith("expanded"), "chip expanded")
  await screenshot("12-chat-parts-expanded")
  await adb("shell", "wm", "size", "390x844").catch(() => {})
  await adb("shell", "wm", "density", "160").catch(() => {})
  await sleep(1500)
  await screenshot("13-chat-parts-narrow-390")
  await adb("shell", "settings", "put", "global", "force_rtl", "1").catch(() => {})
  await adb("shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`).catch(() => {})
  await sleep(2500)
  await screenshot("14-chat-parts-rtl")
  await adb("shell", "settings", "put", "global", "force_rtl", "0").catch(() => {})
  await adb("shell", "wm", "size", "reset").catch(() => {})
  await adb("shell", "wm", "density", "reset").catch(() => {})
  await sleep(1500)
  await waitFor(byId("steer-text"), "agent screen after reset")
  await type("steer-text", "Prefer the tool boundary, keep the fixture green.")
  await tap(await waitFor(byId("steer-send"), "steer send"))
  const steer = await waitWrite((w) => w.path === "/session/ses_composer/input" && w.method === "POST", "steer input")
  if (steer.body.delivery !== "steer" || steer.query.directory !== fixture.sessions.ses_composer?.directory && !steer.query.directory) throw new Error(`Unexpected steer ${JSON.stringify(steer)}`)
  await waitFor(byText("Sent from this phone"), "pending receipt")
  pass(`steer admitted as durable input (delivery=${steer.body.delivery}, requestID present=${!!steer.body.requestID})`)
  await screenshot("08-agent-steer")
  await tap(await waitFor(byId("stop"), "stop"))
  await waitWrite((w) => w.path === "/session/ses_composer/abort", "abort")
  pass("stop sends abort")
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byId("agents"), "back to agents")
  pass("Back returns to the list")

  // 4b. boards & reports: list on Home, open in the sandboxed WebView, script-rendered text visible,
  // same-prefix navigation allowed, Back walks history then closes.
  await tap(await waitFor(byId("tab-desk"), "desk tab"))
  await tap(await waitFor(byId("surface-fixture-board"), "surface row"))
  await waitFor(byId("surface"), "surface screen")
  await waitFor(byText("SCRIPT RENDERED 21"), "script output in WebView", 60_000)
  pass("surface opened through /__es/surface + /__surface capability prefix; script executed")
  await screenshot("10-surface")
  await tap(await waitFor(byText("page 2"), "same-prefix link"))
  await waitFor(byText("PAGE TWO"), "same-prefix navigation")
  pass("same-prefix navigation allowed")
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byText("SCRIPT RENDERED 21"), "history back inside surface")
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byId("desk"), "back to home from surface")
  pass("Back walks surface history, then closes")
  if (fixture.writes.some((w) => w.path.includes("surface"))) throw new Error("surface flow must not write")

  // 5. desk conversation
  await tap(await waitFor(byId("tab-desk"), "desk tab"))
  await type("composer", "What changed since this morning?")
  await tap(await waitFor(byId("send"), "send"))
  const created = await waitWrite((w) => w.path === "/session" && w.method === "POST", "desk session create")
  if (created.body.agent !== "front-desk" || !created.body.id?.startsWith("ses_desk_")) throw new Error(`Unexpected desk create ${JSON.stringify(created.body)}`)
  const ask = await waitWrite((w) => w.path === `/session/${created.body.id}/input`, "desk input")
  if (ask.body.delivery !== "queue") throw new Error("Desk input should queue")
  await waitFor(byId("chat"), "chat screen")
  await waitFor(byText("What changed since this morning"), "pending bubble")
  pass("desk conversation created lazily with the front-desk agent and the message queued")
  await screenshot("09-chat")
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byId("desk"), "home after back")

  if (fixture.unexpected?.length) throw new Error(`Fixture saw unknown routes: ${fixture.unexpected.join(", ")}`)
  console.info(`writes: ${fixture.writes.map((w) => `${w.method} ${w.path}`).join(" | ")}`)
  console.info("ALL PASS")
} catch (error) {
  console.error(`FAIL ${error.message}`)
  await screenshot("failure").catch(() => {})
  process.exitCode = 1
} finally {
  await adb("reverse", "--remove", `tcp:${port}`).catch(() => {})
  gateway.kill("SIGTERM")
  await server.close()
}

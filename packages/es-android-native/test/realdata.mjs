// Read-only smoke against the real loopback backends (Core :4096, dashboard :7777) through a
// private gateway on a spare port with a throwaway pairing code. Only GET traffic results:
// the script never taps a write control. The code is never printed.
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import net from "node:net"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const root = fileURLToPath(new URL("..", import.meta.url))
const artifacts = process.env.ES_ARTIFACTS ?? path.join(root, "dist/artifacts-real")
await mkdir(artifacts, { recursive: true })
const serial = process.env.ES_ANDROID_SERIAL
if (!serial) throw new Error("Set ES_ANDROID_SERIAL")
const sdk = process.env.ANDROID_HOME ?? path.join(homedir(), "Library/Android/sdk")
const run = promisify(execFile)
const adb = async (...args) => (await run(path.join(sdk, "platform-tools/adb"), ["-s", serial, ...args], { encoding: "buffer", maxBuffer: 64 << 20, timeout: 30_000 })).stdout
const pkg = "ai.opencode.desk"
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
const code = Array.from(randomBytes(20), (byte, index) => alphabet[byte % alphabet.length] + ((index + 1) % 5 === 0 && index < 19 ? "-" : "")).join("")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const spare = () => new Promise((resolve) => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)) }) })

const port = await spare()
const renderer = await mkdtemp(path.join(tmpdir(), "desk-gateway-"))
await writeFile(path.join(renderer, "index.html"), "<!doctype html><title>gateway</title>")
const gateway = spawn("bun", [path.join(root, "../es-android/src/gateway.ts"), "--port", String(port), "--root", renderer], {
  cwd: path.join(root, "../es-android"),
  env: { ...process.env, OPENCODE_URL: "http://127.0.0.1:4096", ES_DASHBOARD_URL: "http://127.0.0.1:7777", ES_REMOTE_PAIRING_CODE: code, OPENCODE_SERVER_PASSWORD: "" },
  stdio: ["ignore", "pipe", "inherit"],
})
await new Promise((resolve, reject) => {
  gateway.once("exit", (status) => reject(new Error(`Gateway exited ${status}`)))
  gateway.stdout.on("data", (chunk) => { if (String(chunk).includes("Editspace gateway")) resolve() })
})

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
const byId = (id) => (node) => node["resource-id"] === id
const tap = async (node) => { const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number); await adb("shell", "input", "tap", String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2))) }
const hideKeyboard = async () => { const ime = await adb("shell", "dumpsys", "input_method").catch(() => ""); if (!/mInputShown=true/.test(String(ime))) return; await adb("shell", "input", "keyevent", "KEYCODE_BACK"); await sleep(400) }
const typeText = async (value) => { for (const chunk of value.match(/.{1,6}/g) ?? []) { await adb("shell", "input", "text", `'${chunk}'`); await sleep(120) } }
const screenshot = async (name) => { await sleep(800); await writeFile(path.join(artifacts, `${name}.png`), await adb("exec-out", "screencap", "-p")); console.info(`shot ${name}.png`) }

try {
  await adb("shell", "pm", "clear", pkg)
  await reverse()
  await adb("shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`)
  await tap(await waitFor(byId("origin"), "origin"))
  await adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", ...Array(40).fill("KEYCODE_DEL"))
  await typeText(`http://127.0.0.1:${port}`)
  await hideKeyboard()
  await tap(await waitFor(byId("code"), "code"))
  await typeText(code)
  await hideKeyboard()
  await tap(await waitFor(byId("pair"), "pair"))
  await waitFor(byId("desk"), "desk")
  // Let the first full refresh land (real state responses are large).
  await waitFor((node) => node.text?.toUpperCase().startsWith("UPDATED"), "first refresh", 90_000)
  await screenshot("real-01-desk")
  await tap(await waitFor(byId("tab-needs"), "needs"))
  await waitFor(byId("needs"), "needs screen")
  await screenshot("real-02-needs-you")
  await tap(await waitFor(byId("tab-agents"), "agents"))
  await waitFor(byId("agents"), "agents screen")
  await screenshot("real-03-agents")
  // Open the first agent row (read-only: transcript, plan, receipts).
  const rows = (await nodes()).filter((node) => node.class === "android.view.View" && node.clickable === "true" && node["resource-id"] === "")
  const row = rows.find((node) => Number(node.bounds.match(/\d+/g)[1]) > 300)
  if (row) { await tap(row); await waitFor(byId("agent"), "agent screen"); await waitFor(byId("steer-text"), "steer bar"); await sleep(6000); await screenshot("real-04-agent") }
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byId("agents"), "back")
  console.info("ALL PASS (read-only)")
} catch (error) {
  console.error(`FAIL ${error.message}`)
  await screenshot("real-failure").catch(() => {})
  process.exitCode = 1
} finally {
  // Leave the app unpaired from this throwaway gateway.
  await adb("shell", "pm", "clear", pkg).catch(() => {})
  await adb("reverse", "--remove", `tcp:${port}`).catch(() => {})
  gateway.kill("SIGTERM")
}

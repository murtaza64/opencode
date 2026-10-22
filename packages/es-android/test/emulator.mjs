// End-to-end check of the APK on an already-booted headless emulator
// (ES_ANDROID_SERIAL). Drives native views through uiautomator and the WebView
// through its debug DevTools socket. Private fixture only.
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import net from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const { expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const root = fileURLToPath(new URL("..", import.meta.url))
const artifacts = path.join(root, "dist/artifacts")
await mkdir(artifacts, { recursive: true })
const serial = process.env.ES_ANDROID_SERIAL
if (!serial) throw new Error("Set ES_ANDROID_SERIAL to a headless emulator owned by this run")
const sdk = process.env.ANDROID_HOME ?? path.join(homedir(), "Library/Android/sdk")
// Async on purpose: the fixture shares this event loop and must keep answering the gateway.
const run = promisify(execFile)
const adb = async (...args) =>
  (await run(path.join(sdk, "platform-tools/adb"), ["-s", serial, ...args], { encoding: "buffer", maxBuffer: 64 << 20 })).stdout
const pkg = "ai.opencode.editspace"
const code = "EMUL2-PAIR3-CODE4-ONLY5"
const spare = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const value = probe.address().port
      probe.close(() => resolve(value))
    })
  })
const port = await spare()
const endpoint = `http://127.0.0.1:${port}`
const pass = (text) => console.info(`PASS ${text}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fixture = await createFixture()
fixture.status = "idle"
fixture.permissions = []
fixture.mail = (_, lane) => ({ editspace: "fixture", lane, messages: [] })
fixture.messages = [
  {
    info: { id: "msg_1", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
    parts: [{ id: "part_1", messageID: "msg_1", sessionID: "ses_a", type: "text", text: "Fixture question from the host." }],
  },
  {
    info: {
      id: "msg_2", parentID: "msg_1", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build",
      providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, time: { created: 2, completed: 3 },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "part_2", messageID: "msg_2", sessionID: "ses_a", type: "text", text: "Fixture answer rendered in the Android WebView." }],
  },
]

let gateway
const gatewayOutput = []
const startGateway = async () => {
  gateway = spawn("bun", ["src/gateway.ts", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, ES_REMOTE_PAIRING_CODE: code, OPENCODE_SERVER_PASSWORD: "" },
    stdio: ["ignore", "pipe", "inherit"],
  })
  await new Promise((resolve, reject) => {
    gateway.once("exit", (status) => reject(new Error(`Gateway exited ${status}`)))
    gateway.stdout.on("data", (chunk) => {
      gatewayOutput.push(String(chunk))
      if (String(chunk).includes("Editspace gateway")) resolve()
    })
  })
}
const stopGateway = async () => {
  if (gateway.exitCode !== null || gateway.signalCode !== null) return
  const exited = new Promise((resolve) => gateway.once("exit", resolve))
  gateway.kill("SIGTERM")
  await exited
}

const nodes = async () => {
  // uiautomator occasionally dies mid-dump while the window animates; the caller retries.
  try {
    await adb("shell", "uiautomator", "dump", "/sdcard/es-ui.xml")
  } catch {
    return []
  }
  return [...String(await adb("shell", "cat", "/sdcard/es-ui.xml")).matchAll(/<node [^>]*>/g)].map((match) =>
    Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]])),
  )
}
const waitFor = async (predicate, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  for (let delay = 250; ; delay = Math.min(delay * 2, 2000)) {
    const found = (await nodes()).find(predicate)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(delay)
  }
}
const tap = async (node) => {
  if (!node) throw new Error("Node not visible")
  const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number)
  await adb("shell", "input", "tap", String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)))
}
// Back closes only the keyboard while it is shown; never send it otherwise (it would leave the screen).
const hideKeyboard = async () => {
  if (!/mInputShown=true/.test(String(await adb("shell", "dumpsys", "input_method")))) return
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await sleep(400)
}
const edits = async () => {
  await hideKeyboard()
  await waitFor((node) => node.class === "android.widget.EditText", "inputs")
  return (await nodes()).filter((node) => node.class === "android.widget.EditText")
}
const replace = async (index, value) => {
  await tap((await edits())[index])
  await adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", ...Array(48).fill("KEYCODE_DEL"))
  if (value) await adb("shell", "input", "text", value)
  await hideKeyboard()
}
const text = (value) => (node) => node.text?.includes(value)
const screenshot = async (name) => writeFile(path.join(artifacts, `emulator-${name}.png`), await adb("exec-out", "screencap", "-p"))
const launch = () => adb("shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`)
// Raw DevTools protocol on this device's WebView socket only (Playwright's
// connectOverCDP needs browser-context APIs that WebView lacks).
const webview = async () => {
  await waitFor((node) => node.class === "android.webkit.WebView", "WebView")
  const pid = String(await adb("shell", "pidof", pkg)).trim()
  const local = await spare()
  await adb("forward", `tcp:${local}`, `localabstract:webview_devtools_remote_${pid}`)
  const deadline = Date.now() + 20_000
  let target
  while (!target) {
    const list = await fetch(`http://127.0.0.1:${local}/json`).then((response) => response.json()).catch(() => [])
    target = list.find((item) => item.type === "page" && item.url.startsWith(endpoint))
    if (!target && Date.now() > deadline) throw new Error("App page not found over DevTools")
    if (!target) await sleep(500)
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const pending = new Map()
  let sequence = 0
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  }
  const evaluate = async (expression) => {
    const id = ++sequence
    const reply = new Promise((resolve) => pending.set(id, resolve))
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }))
    const message = await reply
    if (message.error || message.result.exceptionDetails) throw new Error(JSON.stringify(message.error ?? message.result.exceptionDetails))
    return message.result.result.value
  }
  const until = async (expression, label, timeout = 20_000) => {
    const end = Date.now() + timeout
    for (let delay = 200; ; delay = Math.min(delay * 2, 1000)) {
      const value = await evaluate(expression).catch(() => undefined)
      if (value) return value
      if (Date.now() > end) throw new Error(`Timed out in WebView waiting for ${label}`)
      await sleep(delay)
    }
  }
  return {
    evaluate,
    until,
    close: async () => {
      socket.close()
      await adb("forward", "--remove", `tcp:${local}`)
    },
  }
}
const visibleTextarea = `[...document.querySelectorAll("textarea")].find((node) => node.offsetParent)`
const openSession = (cdp) =>
  cdp.until(
    `(() => { const item = [...document.querySelectorAll("*")].find((node) => !node.childElementCount && node.textContent.trim() === "Composer fixture"); item?.click(); return !!item })()`,
    "session link",
  )
const draftKey = `es-app:composer:1:${JSON.stringify(["ses_a", directory])}`
const draft = "Draft typed in the Android shell"

await startGateway()
try {
  await adb("install", "-r", path.join(root, "dist/editspace-debug.apk"))
  await adb("shell", "pm", "clear", pkg)
  await adb("reverse", `tcp:${port}`, `tcp:${port}`)
  await launch()
  await waitFor(text("Connect to Editspace"), "connect screen")
  await screenshot("connect")

  await replace(0, "http://192.168.1.5:47120")
  await tap(await waitFor((node) => node.text === "Connect", "Connect button"))
  await waitFor(text("Plain http works only"), "cleartext refusal")
  await replace(0, "http://127.0.0.1:1")
  await tap(await waitFor((node) => node.text === "Connect", "Connect button"))
  await waitFor(text("Nothing is listening"), "unreachable message")
  pass("native screen refuses cleartext LAN hosts and reports an unreachable gateway")

  await replace(0, endpoint)
  await replace(1, "WRONG")
  await tap(await waitFor((node) => node.text === "Connect", "Connect button"))
  await waitFor((node) => node.text === "That code does not match.", "native wrong code message")
  await screenshot("wrong-code")
  await replace(1, code)
  await tap(await waitFor((node) => node.text === "Connect", "Connect button"))
  let cdp = await webview()
  await cdp.until(`location.pathname === "/" && !!document.querySelector(".shell")`, "es-app home")
  expect(await cdp.evaluate("navigator.userAgent")).toContain("EditspaceAndroid/0.1")
  pass("pairing in the native screen opens es-app in the WebView")

  await openSession(cdp)
  await cdp.until(`document.body.innerText.includes("Fixture answer rendered in the Android WebView.")`, "transcript")
  await cdp.until(`!!${visibleTextarea}`, "composer")
  await cdp.evaluate(`(() => {
    const node = ${visibleTextarea}
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(node, ${JSON.stringify(draft)})
    node.dispatchEvent(new Event("input", { bubbles: true }))
  })()`)
  await cdp.until(`(localStorage.getItem(${JSON.stringify(draftKey)}) ?? "").includes(${JSON.stringify(draft)})`, "durable draft")
  await screenshot("session")
  pass("session transcript renders and the draft is saved durably")
  await cdp.close()

  await adb("shell", "input", "keyevent", "KEYCODE_HOME")
  await sleep(500)
  await adb("shell", "am", "force-stop", pkg)
  await launch()
  cdp = await webview()
  await cdp.until(`!!document.querySelector(".shell")`, "es-app after relaunch")
  await openSession(cdp)
  await cdp.until(`${visibleTextarea}?.value === ${JSON.stringify(draft)}`, "restored draft")
  pass("after process death the app reopens the paired gateway and restores the draft")
  await cdp.close()

  await stopGateway()
  await adb("shell", "am", "force-stop", pkg)
  await launch()
  await waitFor(text("Can't reach Editspace"), "native error panel")
  await screenshot("offline")
  await startGateway()
  await tap(await waitFor((node) => node.text === "Retry", "Retry button"))
  cdp = await webview()
  await cdp.until(`document.body.innerText.includes("Composer fixture")`, "es-app after retry")
  pass("unreachable host shows a native error; Retry reconnects without re-pairing")

  await openSession(cdp)
  await cdp.until(`${visibleTextarea}?.value === ${JSON.stringify(draft)}`, "draft before send")
  await cdp.until(`document.querySelector(".session-work-status")?.dataset.state === "idle"`, "connected session")
  const send = `[...document.querySelectorAll("button")].find((node) => node.offsetParent && /^Send/.test(node.textContent.trim()))`
  await cdp.until(`${send}?.disabled === false`, "enabled Send")
  await cdp.evaluate(`${send}.click()`)
  await expect.poll(() => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/prompt_async").length).toBe(1)
  expect(JSON.stringify(fixture.calls.find((call) => call.path === "/session/ses_a/prompt_async").body)).toContain(draft)
  await cdp.until(`${visibleTextarea}?.value === ""`, "cleared draft")
  await screenshot("sent")
  pass("send from the WebView reaches the host fixture and clears the draft")
  await cdp.close()

  // Back walks WebView history first; at its root the gateway screen replaces the app.
  for (let press = 0; press < 5 && !(await nodes()).some(text("Forget this gateway")); press++) {
    await adb("shell", "input", "keyevent", "KEYCODE_BACK")
    await sleep(700)
  }
  await waitFor(text("Forget this gateway"), "connect screen from back")
  pass("back at the WebView root returns to the gateway screen")
  expect(fixture.unexpected).toEqual([])
  expect(gatewayOutput.join("")).not.toContain(code)
  pass("gateway output never contains the pairing code")
} finally {
  await stopGateway().catch(() => undefined)
  await fixture.close()
  try {
    await adb("reverse", "--remove", `tcp:${port}`)
  } catch {
    /* already removed */
  }
}

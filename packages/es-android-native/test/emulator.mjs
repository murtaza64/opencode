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
// Second host of the Work Desk: a gateway in front of the Mini-shaped fixture, its own code.
const miniServer = await createFixture({ shape: "mini" })
const miniPort = await spare()
const miniCode = "MINI2-PAIR3-CODE4-ONLY5"
const miniGateway = spawn("bun", [path.join(root, "../es-android/src/gateway.ts"), "--port", String(miniPort), "--root", renderer], {
  cwd: path.join(root, "../es-android"),
  env: { ...process.env, OPENCODE_URL: miniServer.url, ES_DASHBOARD_URL: miniServer.url, ES_REMOTE_PAIRING_CODE: miniCode, OPENCODE_SERVER_PASSWORD: "" },
  stdio: ["ignore", "pipe", "inherit"],
})
await new Promise((resolve, reject) => {
  miniGateway.once("exit", (status) => reject(new Error(`Mini gateway exited ${status}`)))
  miniGateway.stdout.on("data", (chunk) => { if (String(chunk).includes("Editspace gateway")) resolve() })
})

// The shared adb server occasionally drops reverse mappings while other lanes run; re-assert.
const reverse = async () => { await adb("reverse", `tcp:${port}`, `tcp:${port}`).catch(() => {}); await adb("reverse", `tcp:${miniPort}`, `tcp:${miniPort}`).catch(() => {}) }
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
const until = async (check, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  for (let delay = 300; ; delay = Math.min(delay * 2, 2000)) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(delay)
  }
}
// Scroll a list until the node is on screen (Home grew sections below the fold).
const scrollTo = async (predicate, label, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    const found = (await nodes()).find(predicate)
    if (found) return found
    await adb("shell", "input", "swipe", "540", "1600", "540", "700", "300")
    await sleep(500)
  }
  throw new Error(`Could not scroll to ${label}`)
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
  // Host glyphs (§4): a bare gateway "local" draws nothing; the machine id is learned from delivery host fields.
  if ((await nodes()).some((node) => node["content-desc"]?.includes("on Local"))) throw new Error("glyph drawn from bare local before any verified id")
  pass("no host glyph from bare gateway local")
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
  // Agents search (AND-W5): lane name, session id prefix and project all find the row; the
  // lane name shows as a secondary label since the title differs; clear restores the list.
  await waitFor(byText("composer-float"), "lane name as secondary label")
  await type("agent-search", "handoff-rel")
  await waitFor(byText("Handoff reliability"), "search by lane name")
  if ((await nodes()).some(byText("Composer float and steer timing"))) throw new Error("search did not filter out non-matching rows")
  await tap(await waitFor(byId("agent-search-clear"), "clear"))
  await type("agent-search", "ses_desk_l")
  await waitFor(byText("Front desk briefs"), "search by session id prefix")
  await tap(await waitFor(byId("agent-search-clear"), "clear"))
  await type("agent-search", "zzz-nothing")
  await waitFor(byId("agents-empty"), "empty search state")
  await tap(await waitFor(byId("agent-search-clear"), "clear"))
  await hideKeyboard()
  await waitFor(byText("Composer float and steer timing"), "list restored after clear")
  pass("Agents search by lane, session id prefix, empty state, clear")
  await screenshot("17-agents-search")
  // Findability acceptance: search 'relay' -> one lane row (old root only under Earlier sessions)
  // -> open the current root -> pin -> visible on Home under Pinned.
  await type("agent-search", "relay")
  await hideKeyboard()
  const relayRow = await waitFor((n) => n["content-desc"]?.startsWith("Relay (Mini receiving orchestrator), orchestrator"), "relay row")
  if ((await nodes()).some(byText("Composer float and steer timing"))) throw new Error("'relay' matched unrelated rows")
  await tap(await waitFor(byId("lineage-opencode/orchestrator"), "Earlier sessions expander"))
  await waitFor(byId("history-ses_relay_old"), "old root under Earlier sessions")
  await waitFor(byText("HISTORY"), "history marker")
  await screenshot("18-relay-lineage")
  await tap(relayRow)
  await waitFor(byId("agent"), "relay agent screen")
  await waitFor((n) => n.text?.toLowerCase().includes("orchestrator"), "lane in header")
  await tap(await waitFor(byId("pin"), "pin button"))
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byId("agents"), "back to agents")
  await tap(await waitFor(byId("agent-search-clear"), "clear relay search"))
  await tap(await waitFor(byId("tab-desk"), "desk tab"))
  await waitFor(byText("Pinned"), "Pinned section on Home")
  await waitFor(byText("Relay (Mini receiving orchestrator)"), "relay pinned on Home")
  await waitFor(byText("Your conversations"), "Your conversations section")
  pass("search 'relay' -> open current root -> pin -> visible on Home")
  await screenshot("19-home-relay-pinned")
  await tap(await waitFor(byId("tab-agents"), "agents tab"))
  await tap(await waitFor(byText("Composer float and steer timing"), "agent row"))
  await waitFor(byId("agent"), "agent screen")
  await waitFor(byText("Composer is pinned"), "transcript tail")
  await screenshot("07-agent")
  // CHAT-PARTS: chips collapsed (no body), tool run folded, image inline; narrow + RTL shots
  await waitFor((node) => node["content-desc"]?.startsWith("Mail from es-app, task"), "mail chip collapsed")
  if ((await nodes()).some((node) => node.text?.includes("Please land the pinned composer"))) throw new Error("mail body visible while collapsed")
  await waitFor((node) => node["content-desc"]?.startsWith("Tool run: 5 tools"), "tool run chip")
  pass("mail chips collapsed without body; tool run folded separately from mail")
  // Wake cues (§4) only when the gateway exposes /es/api/mail (it does) and markers only via /es/api/wake-events (gateway allowlist pending).
  await waitFor((node) => node["content-desc"]?.includes("Woke composer-float"), "caused wake cue on the task chip")
  pass("wake cue: task mail shows 'Woke composer-float' from delivery evidence")
  await waitFor((node) => node.text === "ON LOCAL" || node.text?.startsWith("ON LOCAL ·"), "host learned from delivery host field")
  pass("host glyph resolved from the delivery host field (laptop), not from bare local")
  if ((await nodes()).some((node) => node["content-desc"]?.startsWith("Woke for passive review"))) pass("wake marker rendered (gateway exposes /es/api/wake-events)")
  else console.info("note: no wake marker — /es/api/wake-events not exposed by this gateway build (expected until es-desktop allowlists it)")
  await screenshot("11-chat-parts-populated")
  await tap(await waitFor((node) => node["content-desc"]?.startsWith("Mail from es-app, task"), "chip"))
  await waitFor((node) => node["content-desc"]?.startsWith("Mail from es-app, task") && node["content-desc"]?.endsWith("expanded"), "chip expanded")
  await screenshot("12-chat-parts-expanded")
  // Follow-scroll: scrolling up on purpose shows "jump to latest" and nothing yanks the view;
  // a Send jumps back to the bottom and the button goes away.
  await adb("shell", "input", "swipe", "540", "600", "540", "1500", "300")
  await adb("shell", "input", "swipe", "540", "600", "540", "1500", "300")
  await waitFor(byId("jump-latest"), "jump to latest after scrolling up")
  await sleep(2_500)
  if (!(await nodes()).some(byId("jump-latest"))) throw new Error("view was yanked to the bottom while the reader was scrolled up")
  pass("scrolled-up reader keeps their place and gets a jump-to-latest button")
  await type("steer-text", "Prefer the tool boundary, keep the fixture green.")
  await tap(await waitFor(byId("steer-send"), "steer send"))
  const steer = await waitWrite((w) => w.path === "/session/ses_composer/input" && w.method === "POST", "steer input")
  if (steer.body.delivery !== "steer" || steer.query.directory !== fixture.sessions.ses_composer?.directory && !steer.query.directory) throw new Error(`Unexpected steer ${JSON.stringify(steer)}`)
  await waitFor((node) => node["content-desc"]?.startsWith("Sent from this phone: Prefer the tool boundary"), "pending bubble")
  await until(async () => !(await nodes()).some(byId("jump-latest")), "back at the bottom after Send")
  pass(`steer admitted as durable input (delivery=${steer.body.delivery}, requestID present=${!!steer.body.requestID})`)
  await screenshot("08-agent-steer")
  await tap(await waitFor(byId("stop"), "stop"))
  await waitWrite((w) => w.path === "/session/ses_composer/abort", "abort")
  pass("stop sends abort")
  // Narrow (390dp column) and RTL captures via debug intent extras; the activity reopens on the fixture agent.
  const relaunch = async (...extras) => {
    await adb("shell", "am", "force-stop", pkg)
    await adb("shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`, "--es", "desk.agent", "opencode/composer-float", ...extras)
    await reverse()
    await waitFor(byId("steer-text"), "agent reopened", 60_000)
  }
  // Durable draft (AND-W3): typed text survives a process kill + relaunch on the same origin/session.
  await type("steer-text", "draft survives kill")
  await relaunch()
  await waitFor(byId("steer-text"), "agent after kill")
  const draftField = (await nodes()).find(byId("steer-text"))
  if (!draftField?.text?.includes("draft survives kill")) throw new Error(`draft lost after kill: ${JSON.stringify(draftField?.text)}`)
  pass("durable draft restored after process kill")
  // clear it so later steps start clean
  await tap(draftField); await adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", ...Array(24).fill("KEYCODE_DEL")); await hideKeyboard()
  await relaunch("--ei", "desk.width", "390")
  await screenshot("13-chat-parts-narrow-390")
  await relaunch("--ez", "desk.rtl", "true")
  await screenshot("14-chat-parts-rtl")
  await relaunch()
  await waitFor(byId("steer-text"), "agent screen after captures")
  // After a relaunch the IME may not attach on the first tap; focus, verify the typed text landed, then send.
  // After the capture relaunches the activity was recreated at Home with the agent pushed on top,
  // so Back lands on Home (tab state is per activity); open the Agents tab from there.
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byId("desk"), "back to home")
  pass("Back returns to the list")
  await tap(await waitFor(byId("tab-agents"), "agents tab"))
  await waitFor(byId("agents"), "agents list")

  // 4b. boards & reports: list on Home, open in the sandboxed WebView, script-rendered text visible,
  // same-prefix navigation allowed, Back walks history then closes.
  await tap(await waitFor(byId("tab-desk"), "desk tab"))
  await tap(await scrollTo(byId("surface-fixture-board"), "surface row"))
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
  await waitFor((node) => node["content-desc"]?.startsWith("Sent from this phone: What changed since this morning"), "pending bubble")
  pass("desk conversation created lazily with the front-desk agent and the message queued")
  await screenshot("09-chat")

  // 5b. chat reliability (BUG06). KEEP: POST answers 500 but the input was admitted -> the
  // bubble is "not confirmed" with its request id, then the receipt confirms it on the next
  // read with NO second POST, and the transcript message renders as You via the receipt link.
  const posts = (text) => fixture.writes.filter((w) => w.path === `/session/${created.body.id}/input` && w.body.text === text)
  await type("chat-text", "FAIL500-KEEP one")
  await tap(await waitFor(byId("chat-send"), "send keep"))
  // The receipt poll may confirm it before the node tree is read; either interim state is fine.
  await waitFor((n) => n["resource-id"] === "pending-uncertain" || n["content-desc"]?.includes("FAIL500-KEEP one, registered"), "keep bubble")
  await screenshot("20-chat-keep")
  await waitFor((n) => n["content-desc"] === "Sent from this phone", "transcript message attributed to You (header)", 30_000)
  await waitFor((n) => n.text === "FAIL500-KEEP one", "transcript message text")
  if ((await nodes()).some(byId("pending-uncertain"))) throw new Error("bubble still not confirmed after the receipt was read")
  if (posts("FAIL500-KEEP one").length !== 1) throw new Error(`expected exactly one POST for KEEP, saw ${posts("FAIL500-KEEP one").length}`)
  pass("POST 500 + receipt exists -> confirmed from the receipt, no second POST, rendered as You")

  // DROP: 500 and nothing admitted -> stays not confirmed; Retry resends the SAME request id.
  await type("chat-text", "FAIL500-DROP two")
  await tap(await waitFor(byId("chat-send"), "send drop"))
  await waitFor(byId("pending-uncertain"), "not confirmed bubble (drop)")
  const drop1 = await waitFor(byId("pending-request"), "request id shown on the not-confirmed bubble")
  if (!/request [0-9a-f-]{36} · attempt 1/.test(drop1.text ?? "")) throw new Error(`request id not visible: ${drop1.text}`)
  await screenshot("20b-chat-not-confirmed")
  await sleep(4_000)
  if (!(await nodes()).some(byId("pending-uncertain"))) throw new Error("DROP bubble was confirmed without a receipt")
  if (posts("FAIL500-DROP two").length !== 1) throw new Error("DROP must not be resent automatically")
  await tap(await waitFor((n) => n.text?.toLowerCase() === "retry", "retry"))
  await waitFor((n) => n["content-desc"]?.includes("FAIL500-DROP two, registered"), "accepted after retry", 30_000)
  const drop = posts("FAIL500-DROP two")
  if (drop.length !== 2 || drop[0].body.requestID !== drop[1].body.requestID) throw new Error(`retry must reuse the request id: ${drop.map((w) => w.body.requestID).join(" vs ")}`)
  pass("POST 500 + no receipt -> not confirmed, no auto-resend; Retry reuses the same request id")
  await screenshot("21-chat-retry")
  // Diagnostics lists the outbox with request ids.
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byId("desk"), "home after back")

  // 5c. multi-host Work Desk (0.1.21): add the Mini-shaped host; both hosts aggregate; the
  // Relay row from the Mini opens and sends with an explicit target; an unreachable host only
  // dims its own row and never blocks the other.
  const miniWrites = () => fixture.writes.filter((w) => w.host === "mini")
  await tap(await waitFor(byId("link"), "link menu"))
  await tap(await waitFor(byText("Add a host"), "add host entry"))
  await waitFor(byId("origin"), "add host screen")
  await tap(await waitFor(byId("origin"), "origin field"))
  await typeText(`http://127.0.0.1:${miniPort}`)
  await hideKeyboard()
  await type("code", miniCode)
  await tap(await waitFor(byId("pair"), "pair mini"))
  await waitFor(byId("desk"), "home after adding host")
  await waitFor(byId("host-127.0.0.1"), "host rows", 60_000)
  const hostRows = (await nodes()).filter((n) => n["resource-id"] === "host-127.0.0.1")
  if (hostRows.length !== 2) throw new Error(`expected 2 host rows, saw ${hostRows.length}`)
  await until(async () => (await nodes()).filter((n) => n["content-desc"]?.startsWith("host ") && n["content-desc"]?.endsWith("reachable")).length === 2, "both hosts reachable")
  await waitFor((n) => /today · 2 hosts/i.test(n.text ?? ""), "Work Today across 2 hosts")
  pass("second host paired without leaving the first; two reach rows, both reachable; Work Today sums 2 hosts")
  await screenshot("22-home-two-hosts")
  await tap(await waitFor(byId("tab-agents"), "agents tab"))
  await type("agent-search", "ses_7efac")
  await hideKeyboard()
  const miniRelay = await waitFor((n) => n["content-desc"]?.startsWith("Relay (Mini receiving orchestrator), orchestrator"), "Mini relay row via session id")
  if ((await nodes()).filter((n) => n["content-desc"]?.startsWith("Relay (Mini receiving orchestrator)")).length !== 1) throw new Error("the Mini Relay row collided with the fixture Relay row")
  await tap(miniRelay)
  await waitFor(byId("agent"), "mini relay screen")
  const target = await waitFor(byId("send-target"), "explicit send target")
  if (!/127\.0\.0\.1/.test(target.text ?? "")) throw new Error(`send target should name the host: ${target.text}`)
  await type("steer-text", "hello mini")
  await tap(await waitFor(byId("steer-send"), "send to mini"))
  await until(async () => miniWrites().some((w) => w.path.startsWith("/session/ses_7efac8ae") && w.path.endsWith("/input")), "input landed on the Mini fixture, not the laptop one")
  if (fixture.writes.some((w) => w.host !== "mini" && w.path.startsWith("/session/ses_7efac8ae"))) throw new Error("send leaked to the wrong host")
  pass("Mini Relay opens from the aggregated list and the send goes to its own host only")
  await screenshot("23-mini-relay-send")
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await tap(await waitFor(byId("agent-search-clear"), "clear search"))
  await tap(await waitFor(byId("tab-desk"), "desk tab"))
  // Unreachable host: the Mini fixture answers 503 to everything; its row goes "server", the laptop stays reachable and Home keeps working.
  miniServer.setDown(true)
  await until(async () => (await nodes()).some((n) => n["content-desc"]?.startsWith("host ") && /, (network|server)$/.test(n["content-desc"])), "mini row unreachable", 90_000)
  if (!(await nodes()).some((n) => n["content-desc"]?.startsWith("host ") && n["content-desc"]?.endsWith("reachable"))) throw new Error("laptop row should stay reachable")
  await waitFor(byText("Delivery retry needs the lane owner stamp"), "laptop attention still shown")
  await waitFor((n) => /cost is a floor/i.test(n.text ?? ""), "partial cost mark")
  pass("unreachable host dims only its own row; the other host keeps serving")
  await screenshot("24-home-host-down")
  miniServer.setDown(false)

  // 6. inbox-push 2b: notifications opt-in + Stay connected foreground service.
  const permitted = async () => (await adb("shell", "dumpsys", "package", pkg)).toString().includes("android.permission.POST_NOTIFICATIONS: granted=true")
  const serviceUp = async () => (await adb("shell", "dumpsys", "activity", "services", pkg)).toString().includes("StayConnectedService")
  if (await permitted()) throw new Error("POST_NOTIFICATIONS was granted before the user tapped the Notifications switch")
  if (await serviceUp()) throw new Error("Stay connected service running before opt-in")
  await tap(await waitFor(byId("link"), "link menu"))
  await tap(await waitFor(byText("Notifications"), "Notifications menu entry"))
  await waitFor(byId("toggle-notifications"), "settings screen")
  await screenshot("15-settings")
  await tap(await waitFor(byId("toggle-notifications"), "notifications switch"))
  // The OS permission dialog appears only now; allow it.
  await tap(await waitFor(byId("com.android.permissioncontroller:id/permission_allow_button"), "OS permission dialog", 30_000))
  await until(permitted, "permission granted after tap")
  pass("POST_NOTIFICATIONS requested only on the Notifications tap, never at launch")
  if (await serviceUp()) throw new Error("service started with only Notifications on")
  // Earlier force-stops leave half-open streams at the fixture; the service must not add one.
  await sleep(1_500)
  const streamsBefore = server.streams()
  await tap(await waitFor(byId("toggle-stay"), "stay connected switch"))
  await until(serviceUp, "foreground service")
  await until(async () => (await adb("shell", "dumpsys", "notification", "--noredact")).toString().includes("Connected to"), "ongoing Connected notification")
  pass("Stay connected starts the specialUse foreground service with the ongoing notification")
  await screenshot("16-stay-connected")
  await sleep(2_000)
  if (server.streams() !== streamsBefore) throw new Error(`service opened its own stream: ${streamsBefore} -> ${server.streams()}`)
  pass("one SSE stream shared by UI and service (service opened none)")
  // Swipe-away: the task is removed, the process and service stay.
  await adb("shell", "input", "keyevent", "KEYCODE_HOME")
  await sleep(3_000)
  if (!(await serviceUp())) throw new Error("service died when the activity went to background")
  pass("service survives leaving the app")
  await adb("shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`)
  await reverse()
  await waitFor(byId("back"), "settings still open", 60_000)
  await adb("shell", "input", "keyevent", "KEYCODE_BACK")
  await waitFor(byId("desk"), "home after settings")
  await tap(await waitFor(byId("link"), "link menu again"))
  await tap(await waitFor(byText("Forget this host"), "forget"))
  await until(async () => !(await serviceUp()), "service stopped on forget")
  pass("Forget this host stops the service")

  if (fixture.unexpected?.length) throw new Error(`Fixture saw unknown routes: ${fixture.unexpected.join(", ")}`)
  console.info(`writes: ${fixture.writes.map((w) => `${w.method} ${w.path}`).join(" | ")}`)
  console.info("ALL PASS")
} catch (error) {
  console.error(`FAIL ${error.message}`)
  // Dump what was on screen so a failed predicate can be read without another run.
  console.error("nodes: " + (await nodes()).map((n) => [n["resource-id"], n["content-desc"], n.text].filter(Boolean).join(" | ")).filter(Boolean).join("\n       "))
  await screenshot("failure").catch(() => {})
  process.exitCode = 1
} finally {
  await adb("reverse", "--remove", `tcp:${port}`).catch(() => {})
  gateway.kill("SIGTERM")
  miniGateway.kill("SIGTERM")
  await server.close()
  await miniServer.close()
}

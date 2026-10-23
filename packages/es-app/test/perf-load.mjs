// Renderer responsiveness under live-like event load (es-app#30). Production build served by
// vite preview against the disposable fixture; CPU throttled to mimic a loaded host.
// Measures, per scenario: input latency (Event Timing: keydown/click to next paint), long tasks,
// and Chrome main-thread script/layout/style time, while SSE streams busy-session traffic.
// Run from packages/es-app: node test/perf-load.mjs [--rate 20] [--throttle 4] [--seconds 20] [--label x]
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import net from "node:net"
import { build, preview } from "vite"
import { createFixture, directory, session } from "./composer-fixture.mjs"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const PROFILE = process.argv.includes("--profile")
const ONLY = arg("only", "")
const RATE = Number(arg("rate", 20)), THROTTLE = Number(arg("throttle", 4)), SECONDS = Number(arg("seconds", 20)), LABEL = arg("label", "run")
const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const root = fileURLToPath(new URL("..", import.meta.url))

const fixture = await createFixture()
fixture.status = "busy"
const now = Date.now()
const base = { projectID: "fixture", version: "1", agent: "build" }
fixture.workspaceSessions = Array.from({ length: 40 }, (_, index) => ({ ...base, id: `ses_w${index}`, title: `Worker ${index} doing a long task`, directory,
  time: { created: now - index * 60_000, updated: now - index * 1000 } }))
// A long busy transcript: 120 turns of text with a tool part each.
fixture.messages = Array.from({ length: 120 }, (_, turn) => {
  const user = `msg_${String(turn * 2).padStart(6, "0")}`, assistant = `msg_${String(turn * 2 + 1).padStart(6, "0")}`
  return [
    { info: { id: user, sessionID: "ses_a", role: "user", time: { created: turn * 1000 }, agent: "build", model: { providerID: "fixture", modelID: "test" } },
      parts: [{ id: `prt_${user}`, messageID: user, sessionID: "ses_a", type: "text", text: `Request ${turn}: please look at the module and fix it.` }] },
    { info: { id: assistant, sessionID: "ses_a", role: "assistant", parentID: user, time: { created: turn * 1000 + 1, completed: turn * 1000 + 999 }, agent: "build", mode: "build",
        providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" },
      parts: [
        { id: `prt_${assistant}_t`, messageID: assistant, sessionID: "ses_a", type: "tool", callID: `call_${turn}`, tool: "bash",
          state: { status: "completed", input: { command: `rg pattern ${turn}` }, output: "line\n".repeat(20), title: "rg", metadata: {}, time: { start: 1, end: 2 } } },
        { id: `prt_${assistant}_x`, messageID: assistant, sessionID: "ses_a", type: "text", text: `Done with ${turn}. `.repeat(30) + "\n\n```ts\nconst x = 1\n```" },
      ] },
  ]
}).flat()

// Live-like traffic: a streaming reply in the open session, plus status/updates for many others.
const write = (filter, data) => { for (const [response, entry] of fixture.eventStreams) if (filter(entry)) response.write(`data: ${JSON.stringify(data)}\n\n`) }
const live = { id: "msg_zz_live", part: "prt_zz_live_text" }
let tick = 0
const startTraffic = () => {
  write((e) => e.path === "/event", { type: "message.updated", properties: { info: { id: live.id, sessionID: "ses_a", role: "assistant", parentID: "msg_000238", time: { created: Date.now() }, agent: "build", mode: "build", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } })
  write((e) => e.path === "/event", { type: "message.part.updated", properties: { part: { id: live.part, messageID: live.id, sessionID: "ses_a", type: "text", text: "" } } })
  return setInterval(() => {
    tick++
    const other = `ses_w${tick % 40}`
    const kind = tick % 4
    if (kind === 0 || kind === 2) write((e) => e.path === "/event", { type: "message.part.delta", properties: { sessionID: "ses_a", messageID: live.id, partID: live.part, field: "text", delta: "word ".repeat(3) } })
    if (kind === 1) {
      const event = { type: "session.status", properties: { sessionID: other, status: { type: tick % 8 === 1 ? "busy" : "idle" } } }
      write((e) => e.path === "/event", event)
      write((e) => e.path === "/global/event", { directory, payload: event })
    }
    if (kind === 3) {
      const event = { type: "session.updated", properties: { sessionID: other, info: { ...base, id: other, title: `Worker ${tick % 40} doing a long task`, directory, time: { created: now, updated: Date.now() } } } }
      write((e) => e.path === "/event", event)
      write((e) => e.path === "/global/event", { directory, payload: event })
      write((e) => e.path === "/event", { type: "message.part.updated", properties: { part: { id: `prt_${other}_${tick}`, messageID: `msg_${other}`, sessionID: other, type: "text", text: "x" } } })
    }
  }, 1000 / RATE)
}

process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const outDir = await mkdtemp(path.join(tmpdir(), "es-app-perf-build-"))
// --profile keeps names readable (no minify) so a CPU profile attributes time to source functions.
await build({ root, logLevel: "warn", build: { outDir, emptyOutDir: true, ...(PROFILE ? { minify: false } : {}) } })
const probe = net.createServer()
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const server = await preview({ root, build: { outDir }, preview: { host: "127.0.0.1", port, strictPort: true }, logLevel: "warn" })
const origin = `http://127.0.0.1:${port}`

const browser = await chromium.launch({ channel: "chrome", headless: true })
const results = []
const measure = async (name, url, act) => {
  if (ONLY && ONLY !== name) return
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  await page.goto(url, { timeout: 180_000 })
  await page.waitForTimeout(3000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })
  await page.evaluate(() => {
    window.__perf = { long: [], events: [] }
    new PerformanceObserver((list) => window.__perf.long.push(...list.getEntries().map((e) => e.duration))).observe({ type: "longtask" })
    new PerformanceObserver((list) => window.__perf.events.push(...list.getEntries().map((e) => ({ name: e.name, duration: e.duration, delay: e.processingStart - e.startTime })))).observe({ type: "event", durationThreshold: 16, buffered: false })
  })
  const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]))
  if (PROFILE) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start") }
  const callsBefore = fixture.calls.length
  const traffic = startTraffic()
  const started = Date.now()
  await act(page)
  while (Date.now() - started < SECONDS * 1000) await page.waitForTimeout(250)
  clearInterval(traffic)
  if (PROFILE) {
    const { profile } = await cdp.send("Profiler.stop")
    const self = new Map(), total = profile.samples.length
    const byId = new Map(profile.nodes.map((node) => [node.id, node]))
    const counts = new Map()
    for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const [id, count] of counts) {
      const frame = byId.get(id).callFrame
      const key = `${frame.functionName || "(anon)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}`
      self.set(key, (self.get(key) ?? 0) + count)
    }
    console.log(`PROFILE ${name} top self (of ${total} samples):`)
    for (const [key, count] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${(count * 100 / total).toFixed(1)}%  ${key}`)
    // Inclusive time for app source functions (names from the unminified build).
    const parent = new Map()
    for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
    const inclusive = new Map()
    for (const [id, count] of counts) {
      const seen = new Set()
      for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
        const frame = byId.get(cur).callFrame
        if (!frame.url.includes("/assets/")) continue
        const key = `${frame.functionName || "(anon)"}:${frame.lineNumber + 1}`
        if (seen.has(key)) continue
        seen.add(key)
        inclusive.set(key, (inclusive.get(key) ?? 0) + count)
      }
    }
    console.log(`PROFILE ${name} top inclusive app frames:`)
    for (const [key, count] of [...inclusive].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${(count * 100 / total).toFixed(1)}%  ${key}`)
  }
  const calls = fixture.calls.slice(callsBefore).reduce((map, call) => map.set(call.path.replace(/ses_\w+/g, ":id"), (map.get(call.path.replace(/ses_\w+/g, ":id")) ?? 0) + 1), new Map())
  const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]))
  const perf = await page.evaluate(() => window.__perf)
  const seconds = (Date.now() - started) / 1000
  const d = (key) => after[key] - before[key]
  const inputs = perf.events.filter((e) => ["keydown", "keypress", "keyup", "pointerdown", "pointerup", "click", "input"].includes(e.name)).map((e) => e.duration).sort((a, b) => a - b)
  const pct = (list, p) => list.length ? Math.round(list[Math.min(list.length - 1, Math.floor(list.length * p))]) : 0
  results.push({
    label: LABEL, scenario: name, rate: RATE, throttle: THROTTLE, seconds: Math.round(seconds),
    script_ms_per_s: Math.round(d("ScriptDuration") * 1000 / seconds), layout_ms_per_s: Math.round(d("LayoutDuration") * 1000 / seconds),
    style_ms_per_s: Math.round(d("RecalcStyleDuration") * 1000 / seconds), task_ms_per_s: Math.round(d("TaskDuration") * 1000 / seconds),
    layouts_per_s: Math.round(d("LayoutCount") / seconds), style_recalcs_per_s: Math.round(d("RecalcStyleCount") / seconds),
    long_tasks: perf.long.length, long_ms_total: Math.round(perf.long.reduce((a, b) => a + b, 0)),
    requests: Object.fromEntries([...calls].sort((a, b) => b[1] - a[1]).slice(0, 6)),
    slow_inputs: inputs.length, input_p50_ms: pct(inputs, 0.5), input_p95_ms: pct(inputs, 0.95), input_max_ms: inputs.at(-1) ? Math.round(inputs.at(-1)) : 0,
  })
  console.log(JSON.stringify(results.at(-1)))
  await page.close()
}

const type = async (page, selector) => {
  const box = page.locator(selector).first()
  await box.click()
  for (let index = 0; index < 60; index++) { await page.keyboard.type("a", { delay: 0 }); await page.waitForTimeout(120) }
}
try {
  await measure("session-typing", `${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, (page) => type(page, ".prompt-box textarea"))
  await measure("desk-idle-clicks", `${origin}/`, async (page) => {
    // The desk without a chat has no composer; exercise its queue and mode tabs instead.
    for (let index = 0; index < 8; index++) {
      await page.locator(".desk-item").nth(index % 2).click().catch(() => {})
      await page.waitForTimeout(800)
    }
  })
  await measure("session-clicks", `${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, async (page) => {
    for (let index = 0; index < 8; index++) {
      await page.locator(`.nav-item[href*="ses_w${index}"]`).first().click().catch(() => {})
      await page.waitForTimeout(600)
      await page.locator('.nav-item[href*="ses_a"]').first().click().catch(() => {})
      await page.waitForTimeout(600)
    }
  })
} finally {
  await browser.close()
  await new Promise((resolve) => server.httpServer.close(resolve))
  await fixture.close()
  await rm(outDir, { recursive: true, force: true })
}

// Streaming latency: how soon each live event is visible, and how smooth a long stream is.
// Production build via vite preview against the disposable fixture. The fixture writes each event to the
// page's event stream with a wall-clock stamp; the page samples every animation frame and records the first
// frame that shows it. Reports p50/p95 per event kind plus frame cost during the stream.
// Run from packages/es-app: node test/stream-latency.mjs [--deltas 300] [--interval 25] [--throttle 1] [--label x]
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import net from "node:net"
import { build, preview } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const DELTAS = Number(arg("deltas", 300)), INTERVAL = Number(arg("interval", 25)), THROTTLE = Number(arg("throttle", 1)), LABEL = arg("label", "run")
const TRACE = process.argv.includes("--trace")
// Experiment: delete CSS rules whose selector matches this regex before streaming (attributes style cost).
const STRIP = arg("strip", "")
// With --strip, only matches whose order falls in "from-to" (inclusive) are deleted, for bisection.
// Experiment: extra CSS appended before streaming.
const INJECT = arg("inject", "")
const RANGES = arg("range", "0-100000").split(",").map((item) => item.split("-").map(Number))
const TOOLS = Number(arg("tools", 12)), HISTORY = Number(arg("history", 60))
const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const root = fileURLToPath(new URL("..", import.meta.url))

const fixture = await createFixture()
fixture.status = "busy"
const assistant = (id, parent, created, done) => ({ id, sessionID: "ses_a", role: "assistant", parentID: parent, time: done ? { created, completed: created + 1 } : { created }, agent: "build", mode: "build",
  providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...(done ? { finish: "stop" } : {}) })
const tool = (message, index, status, extra = {}) => ({ id: `prt_${message}_tool_${index}`, messageID: message, sessionID: "ses_a", type: "tool", callID: `call_${message}_${index}`, tool: "bash",
  state: { status, input: { command: `rg TOOLMARK${index} src`, description: `Search TOOLMARK${index}` }, title: `Search TOOLMARK${index}`, metadata: {}, time: { start: Date.now() }, ...extra } })
// History: turns with heavy tool output, as a long agent session has.
fixture.messages = Array.from({ length: HISTORY }, (_, turn) => {
  const user = `msg_${String(turn * 2).padStart(6, "0")}`, reply = `msg_${String(turn * 2 + 1).padStart(6, "0")}`
  return [
    { info: { id: user, sessionID: "ses_a", role: "user", time: { created: turn * 1000 }, agent: "build", model: { providerID: "fixture", modelID: "test" } },
      parts: [{ id: `prt_${user}`, messageID: user, sessionID: "ses_a", type: "text", text: `Request ${turn}` }] },
    { info: assistant(reply, user, turn * 1000 + 1, true),
      parts: [
        ...Array.from({ length: 3 }, (_, index) => tool(reply, index, "completed", { output: `${"x".repeat(100)}\n`.repeat(200), time: { start: 1, end: 2 } })),
        { id: `prt_${reply}_x`, messageID: reply, sessionID: "ses_a", type: "text", text: `Done with ${turn}. `.repeat(20) + "\n\n```ts\nconst x = 1\n```" },
      ] },
  ]
}).flat()
const parent = fixture.messages.at(-1).info.id

const write = (data) => {
  const at = Date.now()
  for (const [response, entry] of fixture.eventStreams) if (entry.path === "/event") response.write(`data: ${JSON.stringify(data)}\n\n`)
  return at
}

process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const outDir = await mkdtemp(path.join(tmpdir(), "es-app-stream-build-"))
await build({ root, logLevel: "warn", build: { outDir, emptyOutDir: true } })
const probe = net.createServer()
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const server = await preview({ root, build: { outDir }, preview: { host: "127.0.0.1", port, strictPort: true }, logLevel: "warn" })
const origin = `http://127.0.0.1:${port}`
const browser = await chromium.launch({ channel: "chrome", headless: true })
const pct = (list, p) => list.length ? Math.round([...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))]) : null

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const history = { bytes: 0 }
  page.on("response", async (response) => {
    if (/\/session\/ses_a\/message/.test(response.url())) history.bytes += (await response.body().catch(() => Buffer.alloc(0))).length
  })
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const opened = Date.now()
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 180_000 })
  await page.locator(".transcript").getByText(`Done with ${HISTORY - 1}.`).first().waitFor({ timeout: 60_000 })
  const historyMs = Date.now() - opened
  await page.waitForTimeout(1500)
  const dom = await page.evaluate(() => ({ nodes: document.querySelectorAll(".transcript *").length, chars: document.querySelector(".transcript")?.textContent?.length ?? 0 }))
  if (STRIP) console.log("STRIPPED", JSON.stringify(await page.evaluate(([source, ranges]) => {
    const pattern = new RegExp(source)
    const removed = []
    let order = 0
    const walk = (list) => { for (let index = list.cssRules.length - 1; index >= 0; index--) { const rule = list.cssRules[index]
      if (rule.cssRules && !rule.selectorText) walk(rule)
      else if (rule.selectorText && pattern.test(rule.selectorText)) { const at = order++; if (!ranges.some(([from, to]) => at >= from && at <= (to ?? from))) continue; removed.push(rule.selectorText.slice(0, 120)); list.deleteRule(index) } } }
    for (const sheet of document.styleSheets) try { walk(sheet) } catch {}
    return removed
  }, [STRIP, RANGES])))
  if (INJECT) await page.addStyleTag({ content: INJECT })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })
  await page.evaluate(() => {
    const state = window.__stream = { want: new Map(), seen: {}, long: [], frames: [], probeMs: 0 }
    new PerformanceObserver((list) => state.long.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" })
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      state.frames.push(now - last)
      last = now
      if (state.want.size) {
        const start = performance.now()
        // Only the live (last) assistant turn changes; scanning it keeps the probe off the measured cost.
        const rows = document.querySelectorAll(".transcript [data-find-message]")
        const text = rows[rows.length - 1]?.textContent ?? ""
        const wall = performance.timeOrigin + now
        for (const [marker, kind] of state.want) if (text.includes(marker)) { state.seen[marker] = { kind, wall }; state.want.delete(marker) }
        state.probeMs += performance.now() - start
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  // Idle cost first: what the page spends with no events (spinners, timers), to separate from per-delta cost.
  const idle0 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]))
  await page.waitForTimeout(3000)
  const idle1 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]))
  const idle = { idle_script_ms_per_s: Math.round((idle1.ScriptDuration - idle0.ScriptDuration) * 1000 / 3), idle_style_ms_per_s: Math.round((idle1.RecalcStyleDuration - idle0.RecalcStyleDuration) * 1000 / 3), idle_style_recalcs_per_s: Math.round((idle1.RecalcStyleCount - idle0.RecalcStyleCount) / 3) }
  const want = (marker, kind) => page.evaluate(([marker, kind]) => window.__stream.want.set(marker, kind), [marker, kind])
  const sent = new Map()
  const events = []
  if (TRACE) {
    cdp.on("Tracing.dataCollected", (data) => events.push(...data.value))
    await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking", transferMode: "ReportEvents" })
  }
  const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]))
  const started = Date.now()
  const live = "msg_zz_live"
  write({ type: "message.updated", properties: { info: assistant(live, parent, Date.now(), false) } })
  let text = ""
  const textPart = (index) => `prt_zz_live_text_${index}`
  let segment = 0
  write({ type: "message.part.updated", properties: { part: { id: textPart(segment), messageID: live, sessionID: "ses_a", type: "text", text: "" } } })
  const toolEvery = Math.max(1, Math.floor(DELTAS / TOOLS))
  for (let index = 0; index < DELTAS; index++) {
    if (index && index % toolEvery === 0 && index / toolEvery <= TOOLS) {
      // A tool call between text segments, as a real turn has: start, run, complete with output.
      const n = index / toolEvery
      const marker = `TOOLMARK${n}`
      await want(marker, "tool.start")
      sent.set(marker, write({ type: "message.part.updated", properties: { part: tool(live, n, "running") } }))
      await new Promise((resolve) => setTimeout(resolve, INTERVAL * 4))
      write({ type: "message.part.updated", properties: { part: tool(live, n, "completed", { output: `OUTMARK${n}\n${"y".repeat(100)}\n`.repeat(200), time: { start: 1, end: 2 } }) } })
      segment++
      text = ""
      write({ type: "message.part.updated", properties: { part: { id: textPart(segment), messageID: live, sessionID: "ses_a", type: "text", text: "" } } })
    }
    const marker = `D${index}Q`
    // Mixed Markdown: plain words, emphasis, list items and a code fence now and then.
    const delta = index % 40 === 39 ? "\n\n```ts\nconst a = 1\n```\n\n" : index % 10 === 9 ? `\n- item **${marker}** ` : ` word ${marker}`
    text += delta
    if (index % 3 === 0) await want(marker, "text.delta")
    sent.set(marker, write({ type: "message.part.delta", properties: { sessionID: "ses_a", messageID: live, partID: textPart(segment), field: "text", delta } }))
    await new Promise((resolve) => setTimeout(resolve, INTERVAL))
  }
  await page.waitForTimeout(1500)
  const seconds = (Date.now() - started) / 1000
  if (TRACE) {
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve))
    await cdp.send("Tracing.end")
    await done
    const updates = events.filter((event) => event.name === "UpdateLayoutTree" && event.dur)
    const elements = updates.map((event) => event.args?.elementCount ?? 0)
    console.log("TRACE UpdateLayoutTree", JSON.stringify({ n: updates.length, total_ms: Math.round(updates.reduce((sum, event) => sum + event.dur, 0) / 1000), p50_elements: pct(elements, 0.5), p95_elements: pct(elements, 0.95) }))
    const reasons = new Map()
    for (const event of events) {
      const data = event.args?.data
      if (!["StyleRecalcInvalidationTracking", "StyleInvalidatorInvalidationTracking", "ScheduleStyleInvalidationTracking"].includes(event.name) || !data) continue
      const key = `${event.name.replace("InvalidationTracking", "")} ${data.reason ?? ""} ${data.nodeName ?? ""} ${(data.invalidationList ?? []).map((item) => JSON.stringify(item)).join(" ").slice(0, 160)} ${data.changedClass ?? ""}${data.changedAttribute ?? ""}${data.changedPseudo ?? ""}${data.changedId ?? ""}`
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
    for (const [key, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log("TRACE", count, key)
  }
  const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]))
  const result = await page.evaluate(() => ({ seen: window.__stream.seen, missing: [...window.__stream.want.keys()], long: window.__stream.long, frames: window.__stream.frames, probeMs: window.__stream.probeMs }))
  const latency = {}
  for (const [marker, value] of Object.entries(result.seen)) (latency[value.kind] ??= []).push(value.wall - sent.get(marker))
  const d = (key) => after[key] - before[key]
  const frames = result.frames.slice(2)
  console.log(JSON.stringify({
    label: LABEL, deltas: DELTAS, interval_ms: INTERVAL, throttle: THROTTLE, history_turns: HISTORY,
    history_open_ms: historyMs, history_bytes: history.bytes, transcript_nodes: dom.nodes, transcript_chars: dom.chars,
    ...Object.fromEntries(Object.entries(latency).flatMap(([kind, list]) => [[`${kind}_n`, list.length], [`${kind}_p50_ms`, pct(list, 0.5)], [`${kind}_p95_ms`, pct(list, 0.95)], [`${kind}_max_ms`, pct(list, 1)]])),
    missing: result.missing.length,
    long_tasks_50: result.long.length, long_ms_total: Math.round(result.long.reduce((a, b) => a + b, 0)),
    frame_p95_ms: pct(frames, 0.95), frames_over_50: frames.filter((frame) => frame > 50).length,
    script_ms_per_s: Math.round(d("ScriptDuration") * 1000 / seconds), layout_ms_per_s: Math.round(d("LayoutDuration") * 1000 / seconds),
    style_ms_per_s: Math.round(d("RecalcStyleDuration") * 1000 / seconds), style_recalcs_per_s: Math.round(d("RecalcStyleCount") / seconds), ...idle, layouts_per_s: Math.round(d("LayoutCount") / seconds),
    probe_ms: Math.round(result.probeMs),
  }))
} finally {
  await browser.close()
  await new Promise((resolve) => server.httpServer.close(resolve))
  await fixture.close()
  await rm(outDir, { recursive: true, force: true })
}

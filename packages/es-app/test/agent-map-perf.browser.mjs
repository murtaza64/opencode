// Agent map under a Mini-sized fleet (perf-lead A1: the installed /agents tab blocked the main thread
// for up to 30 s at a time). Fixture: LANES lanes, each owner with SUBS subagents, plus STANDALONE
// sessions; a burst of session.status events like a busy fleet. Measures long tasks while the map is
// open and statuses flip, and asserts the map stays responsive (no long task over 200 ms).
// Run from packages/es-app: node test/agent-map-perf.browser.mjs [--throttle 4] [--assert] [--all]
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const KIND = arg("kind", "status")
const THROTTLE = Number(arg("throttle", 4)), ASSERT = process.argv.includes("--assert"), ALL = process.argv.includes("--all")
const LANES = Number(arg("lanes", 120)), SUBS = Number(arg("subs", 3)), STANDALONE = Number(arg("standalone", 300)), EVENTS = Number(arg("events", 200))
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")

const now = Date.now()
const lanes = Array.from({ length: LANES }, (_, index) => ({ lane: `lane-${index}`, owner: `ses_l${index}`, status: index % 5 ? "active" : "parked",
  activity: `Working on item ${index}`, activity_at: new Date(now - index * 60_000).toISOString(), activity_session: `ses_l${index}` }))
const ids = []
const sessions = []
const base = { projectID: "fixture", version: "1", agent: "build" }
const add = (id, title, extra = {}) => { ids.push(id); sessions.push({ ...base, id, title, directory, time: { created: now - 9000, updated: now - (ids.length % 50) * 3_600_000 }, ...extra }) }
lanes.forEach((lane, index) => {
  add(lane.owner, `Lane owner ${index}`)
  for (let sub = 0; sub < SUBS; sub++) add(`ses_l${index}_s${sub}`, `subagent ${sub} of ${index}`, { parentID: lane.owner })
})
for (let index = 0; index < STANDALONE; index++) add(`ses_x${index}`, `Standalone session ${index}`)
const statuses = Object.fromEntries(ids.map((id, index) => [id, { type: index % 3 ? "idle" : "busy" }]))

let fixtureURL
const preview = await startAttentionPreview([{
  name: "agent-map-perf-fleet",
  configureServer(server) {
    server.middlewares.use("/es/api/state", async (req, res) => {
      while (!fixtureURL) await new Promise((resolve) => setTimeout(resolve, 50))
      const body = await (await fetch(`${fixtureURL}/api/state${new URL(req.url, "http://preview").search}`)).json()
      body.threads?.push(...lanes.map((lane) => ({ key: lane.lane, kind: "ticket", title: lane.lane, sessions: [], lanes: [lane], tickets: [], prs: [] })))
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    })
    server.middlewares.use("/oc/session/status", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(statuses))
    })
  },
}])
const fixture = preview.fixture
fixtureURL = fixture.url
fixture.workspaceSessions = sessions
console.info(`fixture: ${LANES} lanes, ${sessions.length} sessions`)

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await context.addInitScript(() => {
  window.__long = []
  new PerformanceObserver((list) => window.__long.push(...list.getEntries().map((entry) => ({ t: entry.startTime, d: entry.duration })))).observe({ type: "longtask", buffered: true })
  // Script attribution for slow frames (perf-lead: confirm the cause before fixing).
  window.__loaf = []
  new PerformanceObserver((list) => window.__loaf.push(...list.getEntries().filter((entry) => entry.duration > 100).map((entry) => ({ t: entry.startTime, d: Math.round(entry.duration), style: Math.round(entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0),
    scripts: entry.scripts.map((script) => ({ d: Math.round(script.duration), fn: script.sourceFunctionName, src: (script.sourceURL || "").split("/src/").pop()?.split("?")[0], at: script.sourceCharPosition, invoker: script.invoker, layout: Math.round(script.forcedStyleAndLayoutDuration) })) })))).observe({ type: "long-animation-frame", buffered: true })
})
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const cdp = await context.newCDPSession(page)
const summary = (entries) => ({ long_tasks: entries.length, long_ms: Math.round(entries.reduce((sum, entry) => sum + entry.d, 0)), worst_long_ms: Math.round(Math.max(0, ...entries.map((entry) => entry.d))) })
const rows = []
try {
  await page.goto(`${preview.url}/map${ALL ? "?agents=all" : ""}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(page.locator(".map-node-box").first()).toBeVisible({ timeout: 120_000 })
  await page.waitForTimeout(3000)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })
  const nodes = await page.locator(".map-node-box").count()
  // Status burst: EVENTS flips over ~10 s, like many agents starting and finishing turns.
  const start = await page.evaluate(() => performance.now())
  for (let index = 0; index < EVENTS; index++) {
    const id = ids[(index * 7919) % ids.length]
    if (KIND === "updated") {
      // Title/time updates: each may refresh the global session index (as a busy fleet does).
      const info = sessions.find((item) => item.id === id)
      info.time = { ...info.time, updated: Date.now() }
      fixture.emit("session.updated", { sessionID: id, info })
    } else {
      statuses[id] = { type: statuses[id].type === "busy" ? "idle" : "busy" }
      fixture.emit("session.status", { sessionID: id, status: statuses[id] })
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000 / EVENTS))
  }
  await page.waitForTimeout(2000)
  // The map must still answer a click promptly after the burst.
  // TRACE=1: summarise main-thread time by trace event for the click (style, layout, paint, script).
  if (process.env.TRACE) await page.waitForTimeout(500)
  if (process.env.TRACE) await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] })
  // A raw mouse click, so Playwright's actionability probes (hit tests, intersection checks) stay out of the measurement.
  const box = await page.locator(".map-node-box").first().boundingBox()
  const clickStart = await page.evaluate(() => performance.now())
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator(".map-detail h2")).toBeVisible()
  if (process.env.TRACE) {
    await page.waitForTimeout(500)
    const all = JSON.parse((await browser.stopTracing()).toString()).traceEvents
    const main = all.find((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain")?.tid
    const events = all.filter((event) => event.ph === "X" && event.dur)
    const totals = {}
    for (const event of events) if (event.tid === main && !["RunTask", "ThreadControllerImpl::RunTask", "RunMicrotasks"].includes(event.name)) totals[event.name] = (totals[event.name] ?? 0) + event.dur / 1000
    console.log("TRACE", JSON.stringify(Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, ms]) => [name, Math.round(ms)])))
  }
  const clickMs = Math.round(await page.evaluate(() => performance.now()) - clickStart)
  const entries = await page.evaluate((start) => window.__long.filter((entry) => entry.t >= start), start)
  if (process.env.LOAF) console.log("LOAF", JSON.stringify(await page.evaluate((start) => window.__loaf.filter((entry) => entry.t >= start), start), null, 1))
  rows.push({ step: `${KIND} burst`, throttle: THROTTLE, scope: ALL ? "all" : "active", nodes, events: EVENTS, click_ms: clickMs, ...summary(entries) })
  console.log(JSON.stringify(rows.at(-1)))
  expect(errors).toEqual([])
  if (ASSERT) {
    expect(rows[0].worst_long_ms, "no long task over 200 ms while statuses flip").toBeLessThanOrEqual(200)
    console.log("PASS agent map perf")
  }
} finally {
  await browser.close()
  await preview.close()
}

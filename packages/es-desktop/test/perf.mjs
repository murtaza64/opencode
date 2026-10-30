// Live CPU/render profile of an isolated Editspace window against real services.
// Read-only: a disposable profile, the built renderer, no prompts sent.
//   OPENCODE_URL=http://127.0.0.1:4096 ES_DASHBOARD_URL=http://127.0.0.1:7777 \
//   PERF_SESSION=ses_x PERF_DIRECTORY=/abs/dir PERF_EDITSPACE=opencode PERF_SECONDS=30 node test/perf.mjs
import { _electron } from "@playwright/test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const seconds = Number(process.env.PERF_SECONDS ?? 30)
const profile = await mkdtemp(path.join(tmpdir(), "es-desktop-perf-"))
const app = await _electron.launch({
  args: [root, "--use-mock-keychain"],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    ES_DESKTOP_USER_DATA: profile,
    ES_DESKTOP_RENDERER: "",
  },
})
try {
  const page = await app.firstWindow()
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  if (process.env.PERF_EDITSPACE)
    await page.evaluate((name) => localStorage.setItem("es-app-editspace", name), process.env.PERF_EDITSPACE)
  if (process.env.PERF_ALL_PROJECTS) await page.evaluate(() => localStorage.setItem("es-app-all-projects", "true"))
  const target = process.env.PERF_SESSION
    ? `${origin}/session/${process.env.PERF_SESSION}?directory=${encodeURIComponent(process.env.PERF_DIRECTORY ?? "")}`
    : `${origin}/`
  if (process.env.PERF_REDUCED_MOTION) await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(target)
  await page.waitForTimeout(Number(process.env.PERF_SETTLE ?? 8000))

  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  await cdp.send("Network.enable")
  const requests = new Map()
  let frames = 0
  let frameBytes = 0
  const types = new Map()
  let t0 = Date.now()
  cdp.on("Network.requestWillBeSent", (event) => {
    const url = new URL(event.request.url)
    const key = url.pathname.replace(/ses_[A-Za-z0-9]+/g, ":id")
    if (process.env.PERF_URLS && url.pathname.includes(process.env.PERF_URLS))
      console.error(`${((Date.now() - t0) / 1000).toFixed(1)} ${url.pathname}${url.search}`)
    requests.set(key, (requests.get(key) ?? 0) + 1)
  })
  cdp.on("Network.webSocketFrameReceived", (event) => {
    frames++
    frameBytes += event.response.payloadData.length
    const match = /\\"type\\":\\"([a-z0-9._]+)\\"/.exec(event.response.payloadData)
    const type = match?.[1] ?? "?"
    types.set(type, (types.get(type) ?? 0) + 1)
  })
  const metrics = async () =>
    Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]))
  const processes = () =>
    app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, cpu: m.cpu.cumulativeCPUUsage ?? 0, rss: m.memory.workingSetSize })),
    )
  if (process.env.PERF_MUTATIONS)
    await page.evaluate(() => {
      const counts = (window.__perfMutations = {})
      const describe = (node) => {
        const el = node instanceof Element ? node : node.parentElement
        const path = []
        for (let cur = el; cur && path.length < 4; cur = cur.parentElement)
          path.push(`${cur.tagName.toLowerCase()}${cur.className && typeof cur.className === "string" ? "." + cur.className.split(" ")[0] : ""}${cur.dataset?.component ? `[${cur.dataset.component}]` : ""}`)
        return path.join("<")
      }
      new MutationObserver((records) => {
        for (const record of records) {
          const value = record.type === "attributes" ? record.target.getAttribute(record.attributeName) : ""
          const key = `${record.type}:${record.attributeName ?? ""}${record.attributeName === "data-state" || record.attributeName === "class" ? `=${record.oldValue}->${value}` : ""} ${describe(record.target)}`
          counts[key] = (counts[key] ?? 0) + 1
        }
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true })
    })
  const before = await metrics()
  const p0 = await processes()
  t0 = Date.now()
  if (process.env.PERF_TRACE) await cdp.send("Tracing.start", { categories: "devtools.timeline,v8.execute,disabled-by-default-devtools.timeline", transferMode: "ReturnAsStream" })
  await page.waitForTimeout(seconds * 1000)
  let trace
  if (process.env.PERF_TRACE) {
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve))
    await cdp.send("Tracing.end")
    const { stream } = await done
    const chunks = []
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream })
      chunks.push(chunk.data)
      if (chunk.eof) break
    }
    trace = process.env.PERF_TRACE
    await writeFile(trace, chunks.join(""))
  }
  const elapsed = (Date.now() - t0) / 1000
  if (process.env.PERF_SCREENSHOT) await page.screenshot({ path: process.env.PERF_SCREENSHOT })
  const mutations = process.env.PERF_MUTATIONS
    ? await page.evaluate(() => Object.fromEntries(Object.entries(window.__perfMutations).sort((a, b) => b[1] - a[1]).slice(0, 15)))
    : undefined
  const animations = await page.evaluate(() => {
    const out = {}
    for (const animation of document.getAnimations()) {
      if (animation.playState !== "running") continue
      const target = animation.effect?.target
      const name = `${animation.animationName ?? animation.constructor.name} ${target?.className?.baseVal ?? target?.className ?? target?.tagName ?? ""}${animation.effect?.pseudoElement ?? ""}`
      out[name] = (out[name] ?? 0) + 1
    }
    return out
  })
  const after = await metrics()
  const p1 = await processes()
  const delta = (name) => after[name] - before[name]
  const cpu = p1.map((m) => {
    const prior = p0.find((p) => p.pid === m.pid)
    return { type: m.type, cpuPercent: +(((m.cpu - (prior?.cpu ?? 0)) / elapsed) * 100).toFixed(1), rssMB: Math.round(m.rss / 1024) }
  })
  console.log(JSON.stringify({
    elapsed,
    target: process.env.PERF_SESSION ?? "home",
    processes: cpu,
    renderer: {
      taskPerSec: +(delta("TaskDuration") / elapsed).toFixed(3),
      scriptPerSec: +(delta("ScriptDuration") / elapsed).toFixed(3),
      layoutPerSec: +(delta("LayoutDuration") / elapsed).toFixed(3),
      stylePerSec: +(delta("RecalcStyleDuration") / elapsed).toFixed(3),
      layoutsPerSec: +(delta("LayoutCount") / elapsed).toFixed(1),
      nodes: after.Nodes,
      jsHeapMB: Math.round(after.JSHeapUsedSize / 1048576),
    },
    ws: { framesPerSec: +(frames / elapsed).toFixed(1), kBPerSec: +(frameBytes / 1024 / elapsed).toFixed(1), types: Object.fromEntries([...types].sort((a, b) => b[1] - a[1]).slice(0, 12)) },
    animations,
    mutations,
    requests: Object.fromEntries([...requests].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    trace,
  }, null, 2))
} finally {
  await app.close()
  await rm(profile, { recursive: true, force: true })
}

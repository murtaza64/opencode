import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { preview as vitePreview } from "vite"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

// DD #432: composer keystroke cost vs draft length. Pastes synthetic text (10k/50k/200k chars) into the session
// composer, then types keystrokes one at a time and measures keydown -> next paint in the page, plus main-thread
// task time (CDP Performance.getMetrics) and, with PROFILE=1, a CPU profile's top self-time functions at the
// largest size. Fixture only: no real drafts, clipboard or sends.
// Run from packages/es-app:
//   node test/composer-long-input.perf.mjs                 (Vite dev server, current source)
//   BUNDLE=<dist/renderer dir> node test/composer-long-input.perf.mjs   (a built renderer, e.g. the installed app's)
//   ASSERT=1 ...  fails when a 200k keystroke costs more than 2x a 10k one (median keydown -> paint) or more than
//                 100 ms of main-thread work. Measured (headless, Mini): installed 2026-11-05.1 = 127 ms / 1.24 s / 14.3 s
//                 median at 10k/50k/200k; after = ~75-100 ms at every size.
const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const sizes = (process.env.SIZES ?? "10000,50000,200000").split(",").map(Number)
const keys = Number(process.env.KEYS ?? 20)
const out = process.env.OUT

const server = process.env.BUNDLE ? await bundleServer(process.env.BUNDLE) : await startPanelPreview()
const fixture = server.fixture
fixture.status = "idle"
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const results = []
const errors = []
try {
  for (const size of sizes) {
    // A fresh page per size: no draft carried over (the fixture's storage is per context).
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${server.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { timeout: 300_000 })
    const box = page.getByRole("textbox", { name: "Message" })
    await box.waitFor({ timeout: 120_000 })
    await box.click()
    const cdp = await context.newCDPSession(page)
    await cdp.send("Performance.enable")
    // Synthetic multi-line text, roughly prose-shaped (words, a few @ and links), never real content.
    const line = "Lorem ipsum dolor sit amet, see surface:fixture-board and @nobody at https://example.com/x?y=1 consectetur.\n"
    const text = line.repeat(Math.ceil(size / line.length)).slice(0, size)
    const profilePaste = process.env.PROFILE === "paste" && size === Math.max(...sizes)
    if (profilePaste) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start") }
    const pasteStart = Date.now()
    await cdp.send("Input.insertText", { text })
    await settle(page)
    const pasteMs = Date.now() - pasteStart
    if (profilePaste) { console.log("TOP self-time (ms) during paste at", size); for (const item of topSelf((await cdp.send("Profiler.stop")).profile)) console.log(`  ${item.ms.toFixed(1).padStart(8)}  ${item.name}`) }
    if ((await box.inputValue()).length !== size) throw new Error(`paste of ${size} chars did not land`)
    await page.evaluate(() => {
      window.__lat = []
      const el = document.querySelector('textarea[aria-label="Message"]')
      el.addEventListener("keydown", (event) => {
        const start = event.timeStamp
        // The frame that shows the keystroke: next animation frame, then the task after its paint.
        requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => window.__lat.push(performance.now() - start); channel.port2.postMessage(0) })
      }, true)
    })
    const profile = process.env.PROFILE === "1" && size === Math.max(...sizes)
    if (profile) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start") }
    const before = metrics(await cdp.send("Performance.getMetrics"))
    for (let index = 0; index < keys; index++) {
      await page.keyboard.press(index % 5 === 4 ? "Space" : "x")
      await page.waitForFunction((n) => window.__lat.length > n, index, { timeout: 120_000 })
    }
    const after = metrics(await cdp.send("Performance.getMetrics"))
    const top = profile ? topSelf((await cdp.send("Profiler.stop")).profile) : undefined
    const lat = await page.evaluate(() => window.__lat)
    const value = await box.inputValue()
    if (value.length !== size + keys) throw new Error(`typed ${keys} keys at ${size}: value has ${value.length - size} new chars`)
    const sorted = [...lat].sort((a, b) => a - b)
    const row = { size, pasteMs, keys, medianMs: round(sorted[Math.floor(sorted.length / 2)]), p90Ms: round(sorted[Math.floor(sorted.length * 0.9)]), maxMs: round(sorted.at(-1)),
      taskMsPerKey: round((after.TaskDuration - before.TaskDuration) * 1000 / keys), scriptMsPerKey: round((after.ScriptDuration - before.ScriptDuration) * 1000 / keys),
      layoutMsPerKey: round((after.LayoutDuration - before.LayoutDuration) * 1000 / keys), styleMsPerKey: round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000 / keys) }
    results.push(row)
    console.log(JSON.stringify(row))
    if (top) { console.log("TOP self-time (ms) at", size); for (const item of top) console.log(`  ${item.ms.toFixed(1).padStart(8)}  ${item.name}`) }
    await context.close()
  }
  if (out) writeFileSync(join(out), JSON.stringify({ source: process.env.BUNDLE ?? "vite-dev", results, errors }, null, 2))
  if (errors.length) console.log("page errors:", errors.slice(0, 3))
  const small = results.find((row) => row.size === Math.min(...sizes))
  const large = results.find((row) => row.size === Math.max(...sizes))
  const ratio = large.medianMs / Math.max(small.medianMs, 1)
  console.log(`RATIO median ${large.size}/${small.size}: ${ratio.toFixed(2)}`)
  // Main-thread time per key also stays bounded at the largest size (it was ~14.5 s per key before DD #432).
  if (process.env.ASSERT === "1" && large.taskMsPerKey > 100) { console.log(`FAIL ${large.taskMsPerKey} ms of main-thread work per key at ${large.size} chars`); process.exitCode = 1 }
  else if (process.env.ASSERT === "1" && ratio > 2) { console.log("FAIL keystroke cost scales with draft length"); process.exitCode = 1 }
  else if (process.env.ASSERT === "1") console.log(`PASS composer long input: keystroke -> paint at ${large.size} chars within 2x of ${small.size}`)
} finally {
  await browser.close()
  await server.close()
}

function round(value) { return Math.round(value * 10) / 10 }
function metrics(result) { return Object.fromEntries(result.metrics.map((item) => [item.name, item.value])) }
async function settle(page) { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)))) }
function topSelf(profile) {
  const byID = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map(profile.nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id])))
  const self = new Map()
  const deltas = profile.timeDeltas
  profile.samples.forEach((id, index) => {
    // Native frames (Range rects, layout) are charged to the nearest app function that called them.
    let node = byID.get(id)
    while (node && !node.callFrame.url && parent.has(node.id) && !["(idle)", "(program)", "(garbage collector)"].includes(node.callFrame.functionName)) node = byID.get(parent.get(node.id))
    node ??= byID.get(id)
    const frame = node.callFrame
    const name = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").slice(-1)[0].split("?")[0]}:${frame.lineNumber + 1}`
    self.set(name, (self.get(name) ?? 0) + (deltas[index] ?? 0) / 1000)
  })
  return [...self].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms).slice(0, 18)
}

// A built renderer (dist/renderer) served by Vite's preview server with this app's proxies, against the fixture.
async function bundleServer(outDir) {
  const fixture = await createFixture()
  process.env.OPENCODE_URL = fixture.url
  process.env.ES_DASHBOARD_URL = fixture.url
  const server = await vitePreview({ configFile: new URL("../vite.config.ts", import.meta.url).pathname, build: { outDir }, preview: { port: 0, host: "127.0.0.1" } })
  const address = server.httpServer.address()
  return { fixture, origin: `http://127.0.0.1:${address.port}`, close: async () => { await server.close(); await fixture.close?.() } }
}

// Headed acceptance for the filament overlay on the fixture: screenshots per phase plus real
// frame pacing (headless Chromium paces rAF at ~15 Hz, so only a window measures what users see).
//   OUT=/tmp/filament node test/filament-capture.mjs
import { createRequire } from "node:module"
import { mkdir } from "node:fs/promises"
import { startPanelPreview } from "./composer-panel-preview.mjs"
const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const out = process.env.OUT ?? "/tmp/filament"
await mkdir(out, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ headless: false, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const text = (id, body, end) => ({ id, messageID: "msg_2", sessionID: "ses_a", type: "text", text: body, time: { start: 10, ...(end ? { end } : {}) } })
const tool = (id, status, name = "bash", input = {}, output = "") => ({ id, messageID: "msg_2", sessionID: "ses_a", type: "tool", callID: `call_${id}`, tool: name,
  state: status === "running" ? { status, input, title: `${name} step`, time: { start: Date.now() - 1500 }, metadata: {} }
    : status === "error" ? { status, input, error: "exit 1", time: { start: Date.now() - 1500, end: Date.now() }, metadata: {} }
    : { status, input, output, title: `${name} step`, time: { start: Date.now() - 1500, end: Date.now() }, metadata: {} } })
const big = (n) => "x".repeat(n)
const report = []
const run = async (name, options, query, steps) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(`${preview.url}&filament=1&filamentHud=1${query}`)
  await page.waitForSelector(".filament-canvas")
  await page.waitForTimeout(600)
  for (const [label, act, wait = 900] of steps) {
    await act(page)
    await page.waitForTimeout(wait)
    await page.screenshot({ path: `${out}/${name}-${label}.png` })
    report.push({ run: name, label, phase: await page.evaluate(() => window.__filament.phase()), stats: await page.evaluate(() => window.__filament.stats()), backend: await page.evaluate(() => window.__filament.backend().backend) })
  }
  await context.close()
}
const burst = async (page) => {
  // Stream burst: 60 part updates in ~1s, the shape of a fast model turn.
  for (let i = 1; i <= 60; i++) { fixture.emit("message.part.updated", { part: text("part_ftext", "Looking at how the sidebar handles reconnects. ".repeat(i)) }); await page.waitForTimeout(16) }
}
const steps = [
  ["idle", () => fixture.setStatus("idle")],
  ["thinking", () => { fixture.emit("message.part.updated", { part: { ...text("part_2", "This is an isolated UI preview.", 5) } }); fixture.setStatus("busy") }],
  ["streaming-burst", burst, 300],
  ["tool-running", () => fixture.emit("message.part.updated", { part: tool("part_t1", "running", "grep") }), 1200],
  ["tool-done-next-running", () => { fixture.emit("message.part.updated", { part: tool("part_t1", "completed", "grep") }); fixture.emit("message.part.updated", { part: tool("part_t2", "running", "bash") }) }, 700],
  ["tool-error", () => fixture.emit("message.part.updated", { part: tool("part_t2", "error", "bash") }), 400],
  ["retry", () => fixture.setStatus("retry"), 800],
  ["complete", () => { fixture.emit("message.part.updated", { part: text("part_ftext", "Done.", 99) }); fixture.setStatus("idle") }, 1500],
  // v4: per-command glyphs while running, then split sizes (input ring vs output core) on completion.
  ["glyphs-running", () => { fixture.setStatus("busy"); for (const [id, cmd] of [["part_g1", "git status"], ["part_g2", "jj log -r @"], ["part_g3", "gh pr create"], ["part_g4", "es mail check"], ["part_g5", "aws s3 ls"], ["part_g6", "bun test src"], ["part_g7", "curl -s http://x"], ["part_g8", "docker ps"]]) fixture.emit("message.part.updated", { part: tool(id, "running", "bash", { command: cmd }) }) }, 1200],
  ["sizes-done", () => { fixture.emit("message.part.updated", { part: tool("part_g1", "completed", "bash", { command: "git status" }, big(40)) }); fixture.emit("message.part.updated", { part: tool("part_g2", "completed", "bash", { command: "jj log -r @" }, big(40000)) }); fixture.emit("message.part.updated", { part: tool("part_g3", "completed", "bash", { command: "gh pr create " + big(5000) }, big(100)) }); fixture.emit("message.part.updated", { part: tool("part_g4", "error", "bash", { command: "es mail check" }) }); for (const id of ["part_g5", "part_g6", "part_g7", "part_g8"]) fixture.emit("message.part.updated", { part: tool(id, "completed", "bash", { command: "x" }, big(2000)) }); fixture.setStatus("idle") }, 1500],
]
try {
  await run("chrome", {}, "", steps)
  await run("chrome-rtl-narrow", { viewport: { width: 480, height: 820 } }, "", [["rtl", async (page) => { await page.evaluate(() => { document.documentElement.dir = "rtl" }); fixture.setStatus("busy"); fixture.emit("message.part.updated", { part: tool("part_t3", "running", "read") }) }, 1000]])
  await run("chrome-reduced", { reducedMotion: "reduce" }, "", [["tool", () => { fixture.setStatus("busy"); fixture.emit("message.part.updated", { part: tool("part_t4", "running", "edit") }) }, 800]])
  console.log(JSON.stringify(report, null, 1))
} finally {
  await browser.close()
  await preview.close()
}

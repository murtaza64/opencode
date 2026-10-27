// Front Desk open -> chat visible and interactive, with a desk chat shaped like the live one
// (48 messages, ~1.1 MB: one ~440 KB image file part, bash tool outputs up to ~90 KB, reasoning,
// synthetic context text). Measures time to the latest message visible, time until a keypress
// in the chat composer paints, long tasks and request count; cold load and revisit (Agents -> Desk).
// Run from packages/es-app: node test/desk-open-perf.browser.mjs [--throttle 4] [--assert]
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const THROTTLE = Number(arg("throttle", 4)), ASSERT = process.argv.includes("--assert")
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const fixture = preview.fixture

const fill = (size, seed) => Array.from({ length: Math.ceil(size / 60) }, (_, line) => `${seed} line ${line}: ${"x".repeat(40)} ok`).join("\n").slice(0, size)
const assistant = (id, parent, extra = {}) => ({ id, sessionID: "ses_a", role: "assistant", parentID: parent, agent: "build", mode: "build", providerID: "fixture", modelID: "test",
  path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2, completed: 3 }, finish: "stop", ...extra })
const png = "data:image/png;base64," + "iVBORw0KGgo".padEnd(440_000, "A")
const messages = []
const bashSizes = [90_000, 90_000, 73_000, 69_000, 46_000, 43_000, 20_000, 19_000, 17_000, 15_000, 12_000, 10_000, 8_000, 3_000]
for (let turn = 0; turn < 16; turn++) {
  const user = `msg_${String(turn * 3).padStart(6, "0")}`
  messages.push({ info: { id: user, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: turn } },
    parts: [
      { id: `prt_${user}_t`, messageID: user, sessionID: "ses_a", type: "text", text: `Desk question ${turn}` },
      { id: `prt_${user}_s`, messageID: user, sessionID: "ses_a", type: "text", synthetic: true, text: fill(2200, `context ${turn}`) },
      ...(turn === 3 ? [{ id: `prt_${user}_f`, messageID: user, sessionID: "ses_a", type: "file", mime: "image/png", filename: "screen.png", url: png }] : []),
    ] })
  for (const step of [1, 2]) {
    const id = `msg_${String(turn * 3 + step).padStart(6, "0")}`
    const size = bashSizes[(turn * 2 + step) % bashSizes.length] ?? 2000
    messages.push({ info: assistant(id, user), parts: [
      { id: `prt_${id}_r`, messageID: id, sessionID: "ses_a", type: "reasoning", text: fill(1100, `thinking ${turn}`), time: { start: 1, end: 2 } },
      { id: `prt_${id}_b`, messageID: id, sessionID: "ses_a", type: "tool", callID: `c_${id}`, tool: "bash",
        state: { status: "completed", input: { command: `es status ${turn}` }, output: fill(size, `out ${turn}`), title: "bash", metadata: { output: fill(Math.min(size, 30_000), "meta") }, time: { start: 1, end: 2 } } },
      { id: `prt_${id}_x`, messageID: id, sessionID: "ses_a", type: "text", text: step === 2 ? `LATEST-${turn} answer. ${"Some reply text. ".repeat(20)}` : "" },
    ].filter((part) => part.type !== "text" || part.text) })
  }
}
fixture.messages = messages
console.info(`fixture: ${messages.length} messages, ${Math.round(JSON.stringify(messages).length / 1024)} KB`)

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await context.addInitScript(() => {
  window.__perf = { long: [] }
  new PerformanceObserver((list) => window.__perf.long.push(...list.getEntries().map((entry) => ({ t: entry.startTime, d: entry.duration })))).observe({ type: "longtask", buffered: true })
})
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const cdp = await context.newCDPSession(page)
const rows = []

// Times from `start` (ms, page clock) to latest message visible and to a keypress painting in the chat composer.
const measure = async (name, start) => {
  await page.waitForFunction(() => [...document.querySelectorAll(".desk-chat .transcript")].some((el) => el.textContent.includes("LATEST-15")), undefined, { timeout: 120_000 })
  const visible = await page.evaluate(() => performance.now())
  const box = page.locator(".desk-chat textarea").first()
  await box.click()
  const before = await page.evaluate(() => performance.now())
  await page.keyboard.type("x")
  await page.waitForFunction(() => document.querySelector(".desk-chat textarea")?.value.endsWith("x"))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
  const typed = await page.evaluate(() => performance.now())
  await page.keyboard.press("Backspace")
  const long = await page.evaluate((from) => window.__perf.long.filter((entry) => entry.t >= from), start)
  rows.push({ step: name, throttle: THROTTLE, visible_ms: Math.round(visible - start), first_key_ms: Math.round(typed - before),
    long_tasks: long.length, long_ms: Math.round(long.reduce((sum, entry) => sum + entry.d, 0)), worst_long_ms: Math.round(Math.max(0, ...long.map((entry) => entry.d))) })
}
try {
  // Warm the dev server's transform cache with the throwaway first load.
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await page.waitForFunction(() => document.querySelector(".desk-chat textarea"), undefined, { timeout: 300_000 })
  // Let the warm-up page finish its own reads before counting.
  await page.waitForTimeout(4000)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })
  fixture.calls.length = 0
  await page.reload({ waitUntil: "domcontentloaded" })
  await measure("cold open", 0)
  const coldRequests = fixture.calls.length
  rows.at(-1).requests = coldRequests
  rows.at(-1).desk_message_reads = fixture.calls.filter((call) => call.method === "GET" && call.path === "/session/ses_a/message").length
  if (process.env.DEBUG_READS) console.log("READS", JSON.stringify(fixture.calls.filter((call) => call.method === "GET" && call.path === "/session/ses_a/message").map((call) => `${call.limit}/${call.before ?? ""}`)))
  // Revisit: Agents mode, then back to Front desk.
  await page.locator(".mode-tab", { hasText: "Agents" }).first().click()
  await page.waitForTimeout(1500)
  fixture.calls.length = 0
  const start = await page.evaluate(() => performance.now())
  await page.locator(".mode-tab").first().click()
  await measure("revisit", start)
  rows.at(-1).requests = fixture.calls.length
  rows.at(-1).desk_message_reads = fixture.calls.filter((call) => call.method === "GET" && call.path === "/session/ses_a/message").length
  for (const row of rows) console.log(JSON.stringify(row))
  if (ASSERT) {
    expect(rows[0].desk_message_reads, "cold open reads the desk chat's message page once").toBe(1)
    expect(rows[1].visible_ms, "revisit shows the chat quickly").toBeLessThan(300)
    expect(rows[1].worst_long_ms, "revisit has no long task").toBeLessThan(100)
    console.info("PASS desk open")
  }
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

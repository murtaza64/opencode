// Chat activity (chat-activity-thinking-split-20261103). Above the composer: the sidebar's circular dot, same state
// class as the session's sidebar row (busy, idle; dashed unknown while disconnected), words only in its label.
// Thinking dots appear only while a reasoning part streams with no running tool and no streaming text, never
// from busy alone. The running tool call's icon pulses; none after it completes. Reduced motion: no animation.
// RTL. A Mac Mini session shows the Mini's state.
// Run from packages/es-app: node test/chat-activity.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-chat-activity")
mkdirSync(shots, { recursive: true })
const mini = await createFixture()
mini.status = "busy"
mini.permissions = []
mini.questions = []
const hostRoutes = { name: "test:hosts", configureServer: (server) => { server.middlewares.use((req, res, next) => {
  const match = /^\/hosts\/mini\/(?:oc|es)(\/.*)$/.exec(req.url ?? "")
  if (!match) return next()
  const upstream = httpRequest(`${mini.url}${match[1]}`, { method: req.method, headers: { ...req.headers, host: new URL(mini.url).host } }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers)
    response.pipe(res)
  })
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
  req.pipe(upstream)
}) } }
const preview = await startPanelPreview([hostRoutes])
const fixture = preview.fixture
fixture.status = "busy"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
    { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" }] } }))
  await context.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const line = page.locator(".prompt-box").locator("xpath=preceding::div[contains(@class,'session-work-status')][1]")
  const chatDot = page.locator(".session-work-status:visible .dot")
  const sidebarDot = page.locator('.sidebar a[href*="/session/ses_a"] .dot').first()
  const thinking = page.locator(".session-work-status:visible .thinking-dots")
  await expect(chatDot).toHaveAttribute("data-chat-dot", "busy", { timeout: 120_000 })
  await expect(chatDot).toHaveAttribute("aria-label", "Working")
  expect(await sidebarDot.getAttribute("class")).toContain("busy")
  expect(await chatDot.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("50%")
  // No visible status words, and the old square spinner is gone.
  await expect(page.locator(".session-work-status:visible")).not.toContainText(/Working|Idle|Reconnecting/)
  await expect(page.locator(".session-work-status:visible .busy-dot")).toHaveCount(0)
  // The header's state is the same round dot, its word only in the label.
  const header = page.locator(".session-page .topbar .session-state")
  await expect(header).toHaveAttribute("aria-label", "busy")
  await expect(header).toHaveText("")
  expect(await header.evaluate((el) => [getComputedStyle(el).borderRadius, el.classList.contains("busy")])).toEqual(["50%", true])
  // Busy alone is not thinking.
  await expect(thinking).toHaveCount(0)

  // An open assistant message streaming reasoning: thinking. Text starts streaming: not thinking.
  const info = { id: "msg_think", parentID: "msg_1", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, time: { created: Date.now() }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
  const reasoning = { id: "prt_reason", messageID: info.id, sessionID: "ses_a", type: "reasoning", text: "Let me think", time: { start: Date.now() } }
  fixture.messages.push({ info, parts: [reasoning] })
  fixture.emit("message.updated", { info })
  fixture.emit("message.part.updated", { part: reasoning })
  await expect(thinking).toHaveCount(1)
  await expect(thinking).toHaveAttribute("aria-label", "Thinking")
  await page.screenshot({ path: join(shots, "thinking.png") })
  fixture.emit("message.part.updated", { part: { ...reasoning, time: { start: reasoning.time.start, end: Date.now() } } })
  const tool = { id: "prt_run", messageID: info.id, sessionID: "ses_a", type: "tool", tool: "bash", callID: "call_run",
    state: { status: "running", input: { command: "bun run build" }, title: "", metadata: {}, time: { start: Date.now() } } }
  fixture.emit("message.part.updated", { part: tool })
  await expect(thinking).toHaveCount(0)
  // The running call pulses; exactly one.
  await expect(page.locator(".tool-run-icon[data-running]")).toHaveCount(1)
  expect(await page.locator(".tool-run-icon[data-running]").evaluate((el) => getComputedStyle(el).animationName)).toBe("tool-running")
  await page.screenshot({ path: join(shots, "running.png") })
  fixture.emit("message.part.updated", { part: { ...tool, state: { ...tool.state, status: "completed", output: "ok", metadata: { exit: 0 }, time: { start: tool.state.time.start, end: Date.now() } } } })
  await expect(page.locator(".tool-run-icon[data-running]")).toHaveCount(0)
  // Reasoning again while text streams: not thinking.
  const text = { id: "prt_text", messageID: info.id, sessionID: "ses_a", type: "text", text: "Here", time: { start: Date.now() } }
  fixture.emit("message.part.updated", { part: { ...reasoning, id: "prt_reason2", time: { start: Date.now() } } })
  fixture.emit("message.part.updated", { part: text })
  await page.waitForTimeout(300)
  await expect(thinking).toHaveCount(0)

  // Idle (Core completes the turn's message, then reports idle): dot idle on both; disconnected: dashed unknown.
  const done = { ...info, time: { created: info.time.created, completed: Date.now() } }
  fixture.messages.find((message) => message.info.id === info.id).info = done
  fixture.emit("message.updated", { info: done })
  fixture.setStatus("idle")
  await expect(chatDot).toHaveAttribute("data-chat-dot", "idle")
  fixture.disconnect()
  await expect(chatDot).toHaveAttribute("data-chat-dot", "unknown", { timeout: 30_000 })
  expect(await chatDot.evaluate((el) => getComputedStyle(el).borderStyle)).toBe("dashed")
  await page.reload()

  // Reduced motion: no pulse, no fading dots, a static glow on the running call.
  await page.emulateMedia({ reducedMotion: "reduce" })
  fixture.setStatus("busy")
  // A new turn's open message with a running call.
  const next = { ...info, id: "msg_next", time: { created: Date.now() } }
  const running = { ...tool, id: "prt_run2", callID: "call_run2", messageID: next.id }
  fixture.messages.push({ info: next, parts: [running] })
  fixture.emit("message.updated", { info: next })
  fixture.emit("message.part.updated", { part: running })
  await expect(page.locator(".tool-run-icon[data-running]")).toHaveCount(1, { timeout: 30_000 })
  expect(await page.locator(".tool-run-icon[data-running]").evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).boxShadow !== "none"])).toEqual(["none", true])
  // RTL: the dot leads on the right.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const order = await page.locator(".session-work-status:visible").evaluate((row) => row.querySelector(".dot").getBoundingClientRect().right >= row.getBoundingClientRect().right - 40)
  expect(order).toBe(true)
  await page.screenshot({ path: join(shots, "rtl.png") })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })

  // A Mac Mini session: the Mini's live status.
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`, { waitUntil: "domcontentloaded" })
  await expect(chatDot).toHaveAttribute("data-chat-dot", "busy", { timeout: 60_000 })
  void line
  expect(errors).toEqual([])
  console.log(`PASS chat activity: sidebar circular dot with matching state (busy, idle, dashed unknown), words in its label only; thinking only while reasoning streams (not from busy, not with a running tool or streaming text); one pulsing running tool icon, none after completion; reduced motion static; RTL; Mini session shows the Mini's state; screenshots ${shots}`)
} finally {
  await preview.close()
  await mini.close?.()
  await browser.close()
}

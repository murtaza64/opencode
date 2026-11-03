// A promoted input whose message events never reached this window (DD #343: the desktop message that 'disappeared').
// Its bubble stays as Delivered until the transcript holds the promoted messageID; after ~5 s the message is read by
// id from the session's own host and rendered, then the bubble retires. With the events, no extra read. If Core has
// no such message, the bubble stays (never dropped). A Mac Mini session reads the message from the Mini.
// Run from packages/es-app: node test/delivered-bubble.browser.mjs
import { createRequire } from "node:module"
import { request as httpRequest } from "node:http"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { createFixture, directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
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
// Core promotes the newest pending steer into a user message; `events` decides whether this window hears about it.
const promote = (core, { events, store = true }) => {
  const receipt = core.receipts.at(-1)
  const messageID = `msg_promoted_${receipt.requestID.slice(0, 8)}`
  const info = { id: messageID, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } }
  const part = { id: `prt_${messageID}`, sessionID: "ses_a", messageID, type: "text", text: receipt.text }
  if (store) (core.messages ??= []).push({ info, parts: [part] })
  Object.assign(receipt, { state: "promoted", messageID, timePromoted: Date.now() })
  if (events) { core.emit("message.updated", { info }); core.emit("message.part.updated", { part }) }
  core.emit("session.input.updated", { sessionID: "ses_a" })
  return { messageID, text: receipt.text }
}
const byID = (core, messageID) => core.calls.filter((call) => call.method === "GET" && call.path === `/session/ses_a/message/${messageID}`).length
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
    { id: "local", label: "Local", origin: preview.origin }, { id: "mini", label: "Mac Mini", origin: "https://mini.example.ts.net" }] } }))
  await context.route("**/__es/events", (route) => route.fulfill({ json: { protocol: null } }))
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on("pageerror", (error) => errors.push(error.message))
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  const bubble = (text) => page.locator(".outgoing-item").filter({ hasText: text })
  const steer = async (core, text) => {
    await editor.fill(text)
    await editor.press("Meta+Enter")
    await expect.poll(() => core.receipts.filter((item) => item.text === text).length).toBe(1)
    await expect(bubble(text)).toHaveCount(1)
  }
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await editor.waitFor({ timeout: 120_000 })

  // 1. Events dropped: Delivered bubble, then the message read by id, rendered, bubble gone.
  await steer(fixture, "dropped events steer")
  const dropped = promote(fixture, { events: false })
  await expect(bubble("dropped events steer")).toHaveAttribute("data-status", "delivered")
  await expect(bubble("dropped events steer").locator(".msg-tick")).toHaveAttribute("data-tick", "delivered")
  await expect(page.locator(`[data-find-message="${dropped.messageID}"]`)).toContainText("dropped events steer", { timeout: 15_000 })
  await expect(bubble("dropped events steer")).toHaveCount(0)
  expect(byID(fixture, dropped.messageID)).toBe(1)

  // 2. Events arrive: the bubble retires with no extra read.
  await steer(fixture, "normal steer")
  const normal = promote(fixture, { events: true })
  await expect(page.locator(`[data-find-message="${normal.messageID}"]`)).toContainText("normal steer")
  await expect(bubble("normal steer")).toHaveCount(0)
  await page.waitForTimeout(6000)
  expect(byID(fixture, normal.messageID)).toBe(0)

  // 3. Core has no such message: the bubble stays as Delivered (never dropped).
  await steer(fixture, "missing message steer")
  const missing = promote(fixture, { events: false, store: false })
  await page.waitForTimeout(7000)
  await expect(bubble("missing message steer")).toHaveAttribute("data-status", "delivered")
  expect(byID(fixture, missing.messageID)).toBe(1)

  // 4. A Mac Mini session: the message is read from the Mini.
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}&host=mini`, { waitUntil: "domcontentloaded" })
  await editor.waitFor({ timeout: 60_000 })
  await steer(mini, "mini steer")
  const remote = promote(mini, { events: false })
  await expect(page.locator(`[data-find-message="${remote.messageID}"]`)).toContainText("mini steer", { timeout: 15_000 })
  await expect(bubble("mini steer")).toHaveCount(0)
  expect(byID(mini, remote.messageID)).toBe(1)
  expect(byID(fixture, remote.messageID)).toBe(0)
  expect(errors).toEqual([])
  console.log("PASS delivered bubble: dropped events -> Delivered bubble, message read by id from its host and rendered, then retired; with events no extra read; missing message keeps the bubble; Mini session reads the Mini")
} finally {
  await preview.close()
  await mini.close?.()
  await browser.close()
}

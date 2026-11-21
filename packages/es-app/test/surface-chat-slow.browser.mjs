// Surface owner chat on a slow (cold) owner instance (harness-perf, Murtaza 2026-11-23): the owner session's reads take
// SLOW ms, as a lane directory booting in Core does. Asserts the chat reads the transcript once, not once per Surfaces
// poll (a fresh Surface object used to re-resolve the owner and remount the thread, aborting its read), and that Send
// shows the message at once and issues only prompt_async (no separate session-record read).
// Run from packages/es-app: node test/surface-chat-slow.browser.mjs [--slow 6000]
import { createRequire } from "node:module"
import { injectBridge } from "../surface-bridge.ts"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1] }
const SLOW = Number(arg("slow", 6000))
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.laneOwners = [{ lane: "ux-feel", owner: "ses_a" }]
preview.fixture.status = "idle"
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const now = Date.now()
const surface = () => ({ id: "review", title: "Design review", summary: null, kind: "path", owner: "opencode/ux-feel", lane: "ux-feel", editspace: "fixture", updated_at: now, revision: 4, health: { state: "ok" } })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.clock.install()
await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [surface()] } }))
await page.route("**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } }))
await page.route("**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" },
  body: injectBridge(`<!doctype html><html><body><h1>Design review</h1></body></html>`) }))
await page.route((url) => new URL(url).pathname === "/es/api/surfaces/review/comments", (route) => route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "review", comments: [] } }))
await page.route("**/__es/voice{,/**}", (route) => route.fulfill({ json: { available: false } }))
// The owner session's reads (record, history, todos) wait like a booting instance; nothing else does.
let slow = true
await page.route(/\/oc\/session\/ses_a(\/(message|todo))?\?/, async (route) => {
  if (slow && route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, SLOW))
  return route.continue().catch(() => {})
})
// Counted as the page issues them: a read aborted while it waits never reaches the fixture.
const issued = []
page.on("request", (request) => { if (request.method() === "GET") issued.push(new URL(request.url()).pathname) })
const reads = (path) => issued.filter((item) => item === `/oc${path}`).length
try {
  await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.locator(".sc-toolbar .sc-tool-chat")).toBeEnabled({ timeout: 120_000 })
  const before = reads("/session/ses_a/message")
  const opened = Date.now()
  await page.locator(".sc-toolbar .sc-tool-chat").click()
  const chat = page.locator(".sc-chat")
  await expect(chat.locator("textarea")).toBeVisible()
  // One Surfaces poll (a fresh Surface object) while the owner reads still wait. Fake time stays under the
  // snapshot read's 30 s timeout, which would otherwise abort it on its own.
  await page.clock.runFor(15_500)
  await expect(chat.locator(".sc-chat-empty", { hasText: "Loading the chat" })).toHaveCount(0, { timeout: SLOW * 4 })
  const shownMs = Date.now() - opened
  const historyReads = reads("/session/ses_a/message") - before
  slow = false
  const records = reads("/session/ses_a")
  await chat.locator("textarea").fill("Slow host question")
  const sent = Date.now()
  await chat.locator("textarea").press("Enter")
  await expect(chat.locator(".sc-chat-pending")).toContainText("Slow host question", { timeout: 2000 })
  const bubbleMs = Date.now() - sent
  await expect(chat.locator(".sc-chat-pending .sc-chat-tick")).toHaveText("✓ Sent")
  const recordReadsOnSend = reads("/session/ses_a") - records
  console.log(JSON.stringify({ slow_ms: SLOW, history_reads: historyReads, transcript_ms: shownMs, bubble_ms: bubbleMs, record_reads_on_send: recordReadsOnSend }))
  expect(historyReads, "the transcript is read once, whatever the Surfaces polls do").toBe(1)
  expect(recordReadsOnSend, "Send reuses the thread's session record").toBe(0)
  expect(bubbleMs).toBeLessThan(1000)
  expect(errors).toEqual([])
  console.log("PASS surface chat on a slow owner")
} finally {
  await browser.close()
  await preview.close()
}

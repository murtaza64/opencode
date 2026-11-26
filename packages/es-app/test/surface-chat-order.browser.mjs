// The mini chat's one chronological thread (Laptop .05.1, case surface-mini-chat-history/message-ordering): a human
// message always precedes the agent reply it answers, even when the reply's own created time is earlier, equal, or it
// arrives before the human's echo. Grouping is by real parentID and created time; no invented timestamps. The view
// follows the bottom unless the reader scrolled up. Fixtures only.
// Run from packages/es-app: node test/surface-chat-order.browser.mjs
import { createRequire } from "node:module"
import { injectBridge } from "../surface-bridge.ts"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.laneOwners = [{ lane: "ux-feel", owner: "ses_a" }]
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const SURFACE = { id: "review", title: "Design review", summary: null, kind: "path", owner: "opencode/ux-feel", lane: "ux-feel", editspace: "fixture", updated_at: now, revision: 4, health: { state: "ok" } }
const PAGE = injectBridge(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px sans-serif;margin:24px;background:#16161a;color:#ddd}</style></head><body><h1>Design review</h1><p>Body.</p></body></html>`)
const about = (revision) => ({ type: "text", synthetic: true, text: `Context the person attached: ${JSON.stringify({ kind: "surface", id: "review", host: "fixture", revision })}` })
const user = (id, text, revision, at) => ({ info: { id, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: at } },
  parts: [{ id: `prt_${id}`, sessionID: "ses_a", messageID: id, type: "text", text }, { id: `prt_${id}_ctx`, sessionID: "ses_a", messageID: id, ...about(revision) }] })
const reply = (id, parentID, text, at, completed = true) => ({ info: { id, sessionID: "ses_a", role: "assistant", agent: "build", parentID, providerID: "fixture", modelID: "test", mode: "build",
  path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: at, ...(completed ? { completed: at + 1000 } : {}) } },
  parts: [{ id: `prt_${id}`, sessionID: "ses_a", messageID: id, type: "text", text }] })
const open = async (messages) => {
  preview.fixture.messages = messages
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } }))
  await page.route("**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } }))
  await page.route("**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" }, body: PAGE }))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces/review/comments", (route) => route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "review", comments: [] } }))
  await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.getByRole("button", { name: /^Comment \(C\)/ })).toBeEnabled({ timeout: 120_000 })
  await page.locator(".sc-tool-chat").click()
  await expect(page.locator(".sc-chat")).toBeVisible()
  return { page, context, errors }
}
const thread = (page) => page.locator(".sc-chat-body .sc-chat-msg").evaluateAll((rows) => rows.map((row) => row.textContent.replace(/\s+/g, " ").trim()))
const order = async (page, before, after) => {
  const rows = await thread(page)
  const i = rows.findIndex((text) => text.includes(before))
  const j = rows.findIndex((text) => text.includes(after))
  expect(i, `${before} is in the thread`).toBeGreaterThanOrEqual(0)
  expect(j, `${after} is in the thread`).toBeGreaterThanOrEqual(0)
  expect(i, `${before} precedes ${after}`).toBeLessThan(j)
}

try {
  // A reply whose own created time is before its human, and another with the same created time: the human is first.
  {
    const { page, context, errors } = await open([
      user("msg_early_u", "Human early", 4, now - 500_000),
      reply("msg_early_a", "msg_early_u", "Reply with an earlier timestamp", now - 600_000),
      user("msg_tie_u", "Human tie", 4, now - 400_000),
      reply("msg_tie_a", "msg_tie_u", "Reply with the same timestamp", now - 400_000),
    ])
    const chat = page.locator(".sc-chat")
    await expect(chat).toContainText("Human early", { timeout: 30_000 })
    await order(page, "Human early", "Reply with an earlier timestamp")
    await order(page, "Human tie", "Reply with the same timestamp")
    await order(page, "Reply with an earlier timestamp", "Human tie")
    expect(errors).toEqual([])
    await context.close()
  }

  // A reply arrives before the human's echo (and before Seen): it never shows above the pending human. Reconciliation
  // replaces the pending row with the real human message, and the reply follows it.
  {
    const { page, context, errors } = await open([])
    const chat = page.locator(".sc-chat")
    const input = chat.locator("textarea")
    await input.fill("pending human")
    await chat.getByRole("button", { name: "Send" }).click()
    await expect(chat.locator(".sc-chat-pending")).toContainText("pending human", { timeout: 30_000 })
    await expect(chat.locator(".sc-chat-pending .sc-chat-tick")).toHaveText("✓ Sent")
    const sent = preview.fixture.calls.find((call) => call.method === "POST" && call.path === "/session/ses_a/prompt_async")
    expect(sent?.body?.messageID, "the fixture recorded the send").toBeTruthy()
    const pendingID = sent.body.messageID
    // The agent answers the pending id before the human's echo exists.
    const early = reply("msg_reply_early", pendingID, "Agent answered first", now - 1000)
    preview.fixture.messages.push(early)
    preview.fixture.emit("message.updated", { info: early.info })
    early.parts.forEach((part) => preview.fixture.emit("message.part.updated", { part }))
    await page.waitForTimeout(300)
    await expect(chat.locator(".sc-chat-pending")).toContainText("pending human")
    await expect(chat).not.toContainText("Agent answered first")
    // The human echo reconciles the pending row: the human is above its reply, without a duplicate.
    const human = user(pendingID, "pending human", 4, now)
    preview.fixture.messages.push(human)
    preview.fixture.emit("message.updated", { info: human.info })
    human.parts.forEach((part) => preview.fixture.emit("message.part.updated", { part }))
    await expect(chat).toContainText("Agent answered first", { timeout: 30_000 })
    await expect(chat.locator(".sc-chat-pending")).toHaveCount(0)
    await expect(chat.locator(".sc-chat-msg[data-role=user]", { hasText: "pending human" })).toHaveCount(1)
    await order(page, "pending human", "Agent answered first")
    await expect(chat.locator(".sc-chat-msg[data-role=user]", { hasText: "pending human" }).locator(".sc-chat-tick")).toHaveText("✓✓ Replied")
    expect(errors).toEqual([])
    await context.close()
  }

  // History plus a new streaming reply: the new human leads its reply; the reader at the bottom follows, one who
  // scrolled up stays put.
  {
    const history = []
    for (let index = 0; index < 4; index++) {
      history.push(user(`msg_hist_${index}_u`, `History human ${index}`, 4, now - 700_000 + index * 1000))
      history.push(reply(`msg_hist_${index}_a`, `msg_hist_${index}_u`, `History reply ${index}`, now - 699_500 + index * 1000))
    }
    const { page, context, errors } = await open(history)
    const chat = page.locator(".sc-chat")
    await expect(chat).toContainText("History reply 3", { timeout: 30_000 })
    await page.waitForTimeout(200)
    const next = user("msg_new_u", "New human", 4, now - 100_000)
    const streaming = reply("msg_new_a", "msg_new_u", "Streaming reply", now + 1000, false)
    preview.fixture.messages.push(next, streaming)
    preview.fixture.emit("message.updated", { info: next.info })
    next.parts.forEach((part) => preview.fixture.emit("message.part.updated", { part }))
    preview.fixture.emit("message.updated", { info: streaming.info })
    streaming.parts.forEach((part) => preview.fixture.emit("message.part.updated", { part }))
    await expect(chat).toContainText("Streaming reply", { timeout: 30_000 })
    await order(page, "New human", "Streaming reply")
    const body = chat.locator(".sc-chat-body")
    await expect.poll(() => body.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true)
    // Scrolled up: a further message does not pull the reader down.
    await body.hover()
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(200)
    const before = await body.evaluate((el) => el.scrollTop)
    expect(before, "the history is tall enough to scroll before the new message").toBeGreaterThan(0)
    const later = user("msg_later_u", "Later human", 4, now + 2000)
    const laterReply = reply("msg_later_a", "msg_later_u", "Later reply", now + 3000)
    preview.fixture.messages.push(later, laterReply)
    preview.fixture.emit("message.updated", { info: later.info })
    later.parts.forEach((part) => preview.fixture.emit("message.part.updated", { part }))
    preview.fixture.emit("message.updated", { info: laterReply.info })
    laterReply.parts.forEach((part) => preview.fixture.emit("message.part.updated", { part }))
    await expect(chat).toContainText("Later reply", { timeout: 30_000 })
    await order(page, "Later human", "Later reply")
    expect(Math.abs((await body.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(4)
    expect(errors).toEqual([])
    await context.close()
  }

  console.log("PASS Surface mini chat ordering: human before its reply with early/equal created times, reply-before-echo reconciliation without duplicates, history + new streaming order, bottom follow and scroll preservation")
} finally {
  await browser.close()
  await preview.close()
}

// Message ticks (DOUBLE-TICK, android-ops specs/DOUBLE-TICK.md; desktop port per desktop-delivery #306/#307).
// One steer walks clock (sending, admission held) -> ✓ (durable receipt, "steer, not yet delivered") -> ✓✓ on the
// transcript message once promoted -> ✓✓ accent only after Core's time.turn.started passes the PROMOTION time.
// A turn that started before the promotion leaves it delivered; an older turn start arriving later never steps it
// back. A lost admission shows ! with its Check action. A mail sent row ticks in the mail colour, delivered for
// presented, never accent. The draft is untouched. RTL keeps the tick on the trailing side.
// Run from packages/es-app: node test/double-tick.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-double-tick")
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "busy"
fixture.updateInput = true // Edit appears with the receipt: the tick must not move for it
// A finished mail send by this session, presented to its recipient.
const relay = { id: "msg_relay", parentID: "msg_1", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
  path: { cwd: directory, root: directory }, time: { created: 5, completed: 6 }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
fixture.messages = [...(fixture.messages ?? []), { info: relay, parts: [{ id: "prt_relay", messageID: "msg_relay", sessionID: "ses_a", type: "tool", tool: "bash", callID: "call_relay",
  state: { status: "completed", input: { command: `es mail send --to ux-feel --kind task "look"` }, output: "sent ux-feel#9 (task) transcript-scan -> ux-feel\n  ux-feel: admitted (mail-ux#9-1)",
    title: "", metadata: { exit: 0 }, time: { start: 5, end: 6 } } }] }]
// A long, multi-line prompt already in the transcript: its tick must still sit right under its own bubble.
const long = { id: "msg_long", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 4 } }
fixture.messages = [...fixture.messages, { info: long, parts: [{ id: "prt_long", sessionID: "ses_a", messageID: "msg_long", type: "text",
  text: `first line\nsecond line\n${"a long wrapped sentence that keeps going ".repeat(12)}` }] }]
fixture.mail = (es, scope) => ({ editspace: es, lane: "", messages: [{ id: "ux-feel#9", ts: "2001-01-01T00:00:00Z", created_ms: 5, from: "transcript-scan", to: "ux-feel",
  direction: "sent", kind: "task", text: "look", sender_session: "ses_a",
  deliveries: scope === "ses_a" ? [] : [{ message_id: "ux-feel#9", recipient: "ux-feel", session: "ses_u", mode: "actionable", state: "presented", request_id: null, error: null, presented_at: null, handled_at: null }] }] })
const turn = (started) => fixture.emit("session.updated", { sessionID: "ses_a", info: { ...session("ses_a"), time: { created: 1, updated: Date.now(), turn: { started } } } })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
// Where a tick sits relative to its own bubble: block gap below it and inline-end offset (logical, so RTL reads the same).
const place = (row, bubble) => row.evaluate((element, selector) => {
  const box = element.querySelector(selector).getBoundingClientRect(), tick = element.querySelector(".msg-tick").getBoundingClientRect()
  const rtl = getComputedStyle(element).direction === "rtl"
  return { gap: Math.round(tick.top - box.bottom), end: Math.round(rtl ? tick.left - box.left : box.right - tick.right), x: Math.round(tick.left), y: Math.round(tick.top - box.top) }
}, bubble)
const tight = (where, label) => {
  expect(where.gap, `${label}: tick block gap below its bubble`).toBeGreaterThanOrEqual(0)
  expect(where.gap, `${label}: tick block gap below its bubble`).toBeLessThanOrEqual(6)
  expect(Math.abs(where.end), `${label}: tick offset from the bubble's inline-end edge`).toBeLessThanOrEqual(2)
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(20_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const editor = page.locator(".prompt-box textarea[aria-label='Message']")
  await editor.waitFor({ timeout: 120_000 })
  const bubble = page.locator(".outgoing-item[data-request-id]")
  const bubbleTick = bubble.locator(".msg-tick")

  // Sending: the admission is held, so the bubble shows the clock.
  fixture.holdInput = true
  await editor.fill("steer one")
  await page.getByRole("button", { name: "Steer", exact: true }).click()
  await expect(bubbleTick).toHaveAttribute("data-tick", "sending")
  await expect(bubbleTick).toHaveAttribute("aria-label", "Sending")
  const sending = await place(bubble, ".pending-bubble")
  tight(sending, "sending")
  // Sent: Core's durable receipt arrives.
  fixture.holdInput = false
  fixture.inputReplies.shift()?.()
  await expect(bubbleTick).toHaveAttribute("data-tick", "sent")
  await expect(bubbleTick).toHaveAttribute("aria-label", /^Sent \d.* · steer, not yet delivered$/)
  // Edit and Cancel appear with the receipt; the tick keeps its place.
  await expect(bubble.getByRole("button", { name: /^Edit steer input/ })).toBeVisible()
  const sent = await place(bubble, ".pending-bubble")
  tight(sent, "sent")
  expect([sent.x, sent.y], "tick moved when the receipt's actions appeared").toEqual([sending.x, sending.y])
  await editor.fill("next draft, untouched")
  await page.screenshot({ path: join(shots, "sent.png") })

  // Delivered: Core promotes the steer into a user message at its promotion time; the bubble retires.
  const receipt = fixture.receipts.at(-1)
  const promoted = Date.now()
  turn(promoted - 5_000) // the current turn started before the promotion (a steer)
  const info = { id: "msg_steer_one", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: promoted } }
  const part = { id: "prt_steer_one", sessionID: "ses_a", messageID: info.id, type: "text", text: "steer one" }
  fixture.messages.push({ info, parts: [part] })
  Object.assign(receipt, { state: "promoted", messageID: info.id, timePromoted: promoted })
  fixture.emit("message.updated", { info })
  fixture.emit("message.part.updated", { part })
  fixture.emit("session.input.updated", { sessionID: "ses_a" })
  const own = page.locator(`[data-find-message="${info.id}"] .msg-tick`)
  await expect(own).toHaveAttribute("data-tick", "delivered", { timeout: 15_000 })
  await expect(own).toHaveAttribute("aria-label", /^Delivered \d.* · not read yet$/)
  const transcript = (id) => page.locator(`[data-find-message="${id}"] .msg-wrap`)
  tight(await place(transcript(info.id), '[data-slot="user-message-text"]'), "delivered")
  tight(await place(transcript("msg_long"), '[data-slot="user-message-text"]'), "delivered, long multi-line")
  // Hovering shows the copy line under the tick; the tick does not move.
  const still = await place(transcript("msg_long"), '[data-slot="user-message-text"]')
  await transcript("msg_long").locator('[data-slot="user-message-text"]').hover({ position: { x: 8, y: 8 } })
  await expect(transcript("msg_long").locator('[data-slot="user-message-copy-wrapper"]')).toHaveCSS("opacity", "1")
  expect(await place(transcript("msg_long"), '[data-slot="user-message-text"]'), "tick moved on hover").toEqual(still)
  await page.screenshot({ path: join(shots, "delivered.png") })
  await expect(bubble).toHaveCount(0)
  // Read: only a turn start after the promotion lights it.
  turn(promoted + 2_000)
  await expect(own).toHaveAttribute("data-tick", "read")
  await expect(own).toHaveAttribute("aria-label", /^Delivered \d.* · read \d/)
  // An older turn start arriving out of order never steps it back.
  turn(promoted - 5_000)
  await page.waitForTimeout(500)
  await expect(own).toHaveAttribute("data-tick", "read")
  await expect(editor).toHaveValue("next draft, untouched")

  // Not sent: an admission whose reply is lost shows ! with its Check action.
  await editor.fill("lost steer")
  fixture.loseInput = true
  await page.getByRole("button", { name: "Steer", exact: true }).click()
  const lost = page.locator(".outgoing-item[data-request-id]").filter({ hasText: "lost steer" })
  await expect(lost.locator(".msg-tick")).toHaveAttribute("data-tick", "failed", { timeout: 20_000 })
  await expect(lost.getByRole("button", { name: /Check/ })).toBeVisible()
  tight(await place(lost, ".pending-bubble"), "not sent, with Check")
  await page.screenshot({ path: join(shots, "states.png") })

  // Mail sent row (mail ticks, DD #414): presented to the recipient agent is the accent ✓✓, worded "Read by".
  const mailTick = page.locator('.tool-chip[data-timeline-part-id="prt_relay"] .msg-tick')
  await expect(mailTick).toHaveAttribute("data-tick", "read", { timeout: 20_000 })
  await expect(mailTick).toHaveAttribute("aria-label", "Read by ux-feel")
  const colors = await page.evaluate(() => [getComputedStyle(document.querySelector('.tool-chip[data-timeline-part-id="prt_relay"] .msg-tick')).color,
    getComputedStyle(document.querySelector('[data-find-message="msg_steer_one"] .msg-tick')).color,
    getComputedStyle(document.querySelector('.outgoing-item .msg-tick[data-tick="failed"]')).color])
  expect(colors[0]).not.toBe(colors[2])
  expect(new Set(colors.slice(1)).size).toBe(2)

  // RTL: the tick stays on the trailing (left) side of its row.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const side = await page.locator('[data-find-message="msg_steer_one"]').evaluate((row) => {
    const tick = row.querySelector(".msg-tick").getBoundingClientRect(), box = row.getBoundingClientRect()
    return tick.left - box.left < box.right - tick.right
  })
  expect(side).toBe(true)
  tight(await place(transcript("msg_steer_one"), '[data-slot="user-message-text"]'), "RTL delivered")
  tight(await place(lost, ".pending-bubble"), "RTL not sent")
  // Phone width: long bubbles wrap; each tick stays under its own bubble.
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [row, bubble, label] of [[transcript("msg_long"), '[data-slot="user-message-text"]', "phone RTL long"], [lost, ".pending-bubble", "phone RTL not sent"]]) tight(await place(row, bubble), label)
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  for (const [row, bubble, label] of [[transcript("msg_long"), '[data-slot="user-message-text"]', "phone long"], [transcript("msg_steer_one"), '[data-slot="user-message-text"]', "phone delivered"], [lost, ".pending-bubble", "phone not sent"]]) tight(await place(row, bubble), label)
  await page.screenshot({ path: join(shots, "phone.png"), fullPage: false })
  await page.screenshot({ path: join(shots, "rtl.png") })
  expect(errors).toEqual([])
  console.log(`PASS double tick: clock -> ✓ (steer, not yet delivered) -> ✓✓ on promotion -> accent only after a turn start later than the promotion; an earlier or out-of-order turn start never lights or reverts it; lost admission -> ! with Check; mail row in the mail colour, delivered not read; draft untouched; tick tight under its own bubble at its inline-end in every state, unmoved by actions or hover (desktop, phone, RTL, long multi-line); RTL trailing side; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}

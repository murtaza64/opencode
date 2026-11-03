// Porter quiet turns (porter-explicit-attention-chat-ux-20261103; front-desk #1034). In the Front desk chat, a mail or
// wake turn that ends with no text folds with its neighbours into one row "Porter handled N updates", expandable to its
// mail and tool calls; a human prompt's reply always shows; a failed turn always shows; a mail turn whose reply has text
// shows. While the chat is closed, a quiet turn does not leave the desk unread; a reply with text does.
// Run from packages/es-app: node test/quiet-turns.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-quiet-turns")
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
let clock = 10
const mail = (id, text) => ({ info: { id, sessionID: "ses_b", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: clock++ },
  source: { type: "editspace-mail", id: `porter#${id}`, sender: "lane-peer", recipient: "front-desk", kind: "notice" } },
  parts: [{ id: `${id}_t`, messageID: id, sessionID: "ses_b", type: "text", text }] })
const human = (id, text) => ({ info: { id, sessionID: "ses_b", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: clock++ } },
  parts: [{ id: `${id}_t`, messageID: id, sessionID: "ses_b", type: "text", text }] })
const reply = (id, parentID, parts, extra = {}) => ({ info: { id, parentID, sessionID: "ses_b", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
  path: { cwd: directory, root: directory }, time: { created: clock++, completed: clock++ }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra },
  parts: parts.map((part) => ({ ...part, messageID: id, sessionID: "ses_b" })) })
const ack = (id) => ({ id: `${id}_ack`, type: "tool", tool: "bash", callID: `call_${id}`, state: { status: "completed", input: { command: "es mail ack x" }, output: "ok", title: "", metadata: { exit: 0 }, time: { start: 1, end: 2 } } })
const text = (id, value) => ({ id: `${id}_txt`, type: "text", text: value, time: { start: 1, end: 2 } })
fixture.messagesB = [
  human("msg_b01", "What's the status of the build?"), reply("msg_b02", "msg_b01", [text("msg_b02", "The build is green.")]),
  mail("msg_b03", "lane-peer: ack"), reply("msg_b04", "msg_b03", [ack("msg_b04")]),
  mail("msg_b05", "lane-peer: progress 40%"), reply("msg_b06", "msg_b05", [ack("msg_b06")]),
  mail("msg_b07", "lane-peer: review ready"), reply("msg_b08", "msg_b07", [ack("msg_b08"), text("msg_b08", "PR #12 is ready for your review.")]),
  mail("msg_b09", "lane-peer: retry"), reply("msg_b10", "msg_b09", [ack("msg_b10")], { error: { name: "APIError", data: { message: "provider overloaded" } } }),
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await context.addInitScript((value) => { try { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)); localStorage.setItem("es-app:companion:work", "1") } catch {} }, { session: "ses_b", directory })
  // The desk session's title marks it as the Front desk (desk-session verification).
  await context.route("**/oc/session/ses_b?*", async (route) => {
    const response = await route.fetch()
    const body = await response.json().catch(() => undefined)
    if (!body || typeof body !== "object") return route.fulfill({ response })
    return route.fulfill({ response, json: { ...body, title: "Front desk @ses_bbbbbbbbbbbbbbbbbbbbbbbbbb" } })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.on("pageerror", (error) => errors.push(error.message))
  const requests = []
  page.on("console", (message) => { if (message.type() === "error") console.log("CONSOLE", message.text().slice(0, 200)) })
  page.on("requestfinished", async (request) => { const response = await request.response(); if (response && response.status() >= 400) requests.push(`${response.status()} ${new URL(request.url()).pathname}`) })
  process.on("exit", () => { if (errors.length || requests.length) console.log("DIAG", JSON.stringify({ errors, requests: [...new Set(requests)].slice(0, 30) })) })
  await page.goto(`${preview.origin}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const chat = page.locator(".desk-companion")
  await expect(chat.locator('[data-find-message="msg_b02"]')).toContainText("The build is green.", { timeout: 240_000 })

  // Two quiet mail turns fold into one row; the review-ready reply, the failure and the human reply show.
  const fold = chat.locator(".quiet-turns")
  await expect(fold).toHaveCount(1)
  await expect(fold).toHaveText(/Porter handled 2 updates/)
  await expect(fold).toHaveAttribute("aria-expanded", "false")
  for (const id of ["msg_b03", "msg_b04", "msg_b05", "msg_b06"]) await expect(chat.locator(`[data-find-message="${id}"]`)).toHaveCount(0)
  await expect(chat.locator('[data-find-message="msg_b08"]')).toContainText("PR #12 is ready for your review.")
  await expect(chat.locator('[data-find-message="msg_b07"]')).toHaveCount(1)
  await expect(chat.locator('[data-message-error-id="msg_b10"]')).toContainText("provider overloaded")
  await page.screenshot({ path: join(shots, "folded.png") })
  // Expandable to the mail and tool calls it folded, by keyboard.
  await fold.focus()
  await page.keyboard.press("Enter")
  await expect(fold).toHaveAttribute("aria-expanded", "true")
  for (const id of ["msg_b03", "msg_b04", "msg_b05", "msg_b06"]) await expect(chat.locator(`[data-find-message="${id}"]`)).toHaveCount(1)
  await page.screenshot({ path: join(shots, "expanded.png") })
  await page.keyboard.press("Enter")
  await expect(fold).toHaveAttribute("aria-expanded", "false")

  // Closed chat: a quiet turn keeps the desk read; a reply with text leaves it unread.
  await chat.getByRole("button", { name: /^Close/ }).click()
  await expect(chat).toHaveClass(/closed/)
  const viewed = () => page.evaluate(() => JSON.parse(localStorage.getItem("es-app-viewed") ?? "{}").ses_b ?? 0)
  const emit = (message) => { fixture.messagesB.push(message); fixture.emit("message.updated", { info: message.info }); message.parts.forEach((part) => fixture.emit("message.part.updated", { part })) }
  await page.waitForTimeout(11_000) // past the 10 s viewed throttle
  const before = await viewed()
  emit(mail("msg_b11", "lane-peer: wake")); emit(reply("msg_b12", "msg_b11", [ack("msg_b12")]))
  await expect.poll(viewed, { timeout: 15_000 }).toBeGreaterThan(before)
  await page.waitForTimeout(11_000)
  const quietSeen = await viewed()
  emit(mail("msg_b13", "lane-peer: done")); emit(reply("msg_b14", "msg_b13", [text("msg_b14", "The migration finished.")]))
  // After an unseen reply with text, later quiet turns no longer mark the desk viewed: it stays unread until opened.
  await page.waitForTimeout(11_000)
  const afterReply = await viewed()
  emit(mail("msg_b15", "lane-peer: wake")); emit(reply("msg_b16", "msg_b15", [ack("msg_b16")]))
  await page.waitForTimeout(3000)
  expect(await viewed()).toBe(afterReply)
  void quietSeen
  expect(errors).toEqual([])
  console.log(`PASS quiet turns: two text-less mail turns fold into 'Porter handled 2 updates' (keyboard expandable to their mail and tool calls); human reply, review-ready reply and failure shown; closed chat: quiet turn keeps it read, text reply leaves it unread; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}

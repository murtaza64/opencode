// Mic + micro chat with a Surface's author (Loupe item 9; Murtaza Nov 4 ~23:00Z). The toolbar leads mic | chat |
// comment; the mic records at once and its transcript lands as a draft in the chat; the chat reads the author's own
// session (only messages about this Surface and the replies to them) with ticks from that session: Sent (accepted,
// not yet in the session), Seen (in the session), Replied (an answer whose parentID is that message). Minimised it is
// a bubble with an unread count. Fixture daemon + store. Run from packages/es-app: node test/surface-chat.browser.mjs [--shots <dir>]
import path from "node:path"
import { createRequire } from "node:module"
import { injectBridge } from "../surface-bridge.ts"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
preview.fixture.laneOwners = [{ lane: "ux-feel", owner: "ses_a" }]
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const SURFACE = { id: "review", title: "Design review", summary: null, kind: "path", owner: "opencode/ux-feel", lane: "ux-feel", editspace: "fixture", updated_at: now, revision: 4, health: { state: "ok" } }
const PAGE = injectBridge(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px sans-serif;margin:24px;background:#16161a;color:#ddd}</style></head><body><h1>Design review</h1><p id="p">Body.</p></body></html>`)
const about = (revision) => ({ type: "text", synthetic: true, text: `Context the person attached: ${JSON.stringify({ kind: "surface", id: "review", host: "fixture", revision })}` })
const user = (id, text, revision, at) => ({ info: { id, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: at } },
  parts: [{ id: `prt_${id}`, sessionID: "ses_a", messageID: id, type: "text", text }, { id: `prt_${id}_ctx`, sessionID: "ses_a", messageID: id, ...about(revision) }] })
const reply = (id, parentID, text, at) => ({ info: { id, sessionID: "ses_a", role: "assistant", agent: "build", parentID, providerID: "fixture", modelID: "test", mode: "build", path: { cwd: directory, root: directory }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: at, completed: at + 1000 } }, parts: [{ id: `prt_${id}`, sessionID: "ses_a", messageID: id, type: "text", text }] })
// The author's session: other work (not shown) and one earlier exchange about this Surface (shown).
preview.fixture.messages = [
  { info: { id: "msg_0other", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: now - 900_000 } }, parts: [{ id: "prt_0other", sessionID: "ses_a", messageID: "msg_0other", type: "text", text: "Unrelated task" }] },
  user("msg_1ask", "Why is the summary below the fold?", 3, now - 600_000),
  reply("msg_2reply", "msg_1ask", "Moved it to the top in r4.", now - 500_000),
]

const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: shots ? 2 : 1 })
const page = await context.newPage()
page.setDefaultTimeout(30_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } }))
await page.route("**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } }))
await page.route("**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" }, body: PAGE }))
await page.route((url) => new URL(url).pathname === "/es/api/surfaces/review/comments", (route) => route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "review", comments: [] } }))
let stopped
await page.route("**/__es/voice{,/**}", (route) => {
  if (new URL(route.request().url()).pathname === "/__es/voice") return route.fulfill({ json: { available: true, state: "idle" } })
  if (route.request().url().endsWith("/stop")) { stopped = route; return }
  return route.fulfill({ json: { ok: true } })
})
const prompts = () => preview.fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/prompt_async")
const shot = async (name) => { if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, `${name}.png`) }) }
try {
  await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const toolbar = page.locator(".sc-toolbar")
  await expect(toolbar.getByRole("button", { name: /^Comment \(C\)/ })).toBeEnabled({ timeout: 120_000 })
  // Order: mic, chat, comment, then the rest.
  const order = await toolbar.locator(":scope > button, :scope > span > button.sc-tool-main, :scope > span > button.sc-tool").evaluateAll((els) => els.slice(0, 3).map((el) => el.className))
  expect(order).toEqual(["sc-tool-mic", "sc-tool-chat", "sc-tool-main"])
  await expect(page.locator(".sc-say")).toHaveCount(0)
  await shot("chat-idle-toolbar")

  // Mic: one click records at once (REC + time, chat opens listening); a second click stops; the transcript is a draft.
  const mic = toolbar.locator(".sc-tool-mic")
  await expect(mic).toBeEnabled()
  await mic.click()
  await expect(mic).toHaveAttribute("data-state", "recording")
  await expect(mic.locator(".sc-rec")).toContainText("0:0")
  await expect(page.locator(".sc-chat textarea")).toHaveAttribute("placeholder", "Listening…")
  await shot("chat-recording")
  await mic.click()
  await expect.poll(() => !!stopped).toBe(true)
  await stopped.fulfill({ json: { ok: true, text: "Can the summary sit beside the chart?" } })
  await expect(page.locator(".sc-chat textarea")).toHaveValue("Can the summary sit beside the chart?")
  expect(prompts()).toHaveLength(0)
  await shot("chat-drafted")

  // The thread: only this Surface's exchange (not the unrelated task), with Replied on the earlier question.
  const chat = page.locator(".sc-chat")
  await expect(chat.locator(".sc-chat-msg")).toHaveCount(2)
  await expect(chat).not.toContainText("Unrelated task")
  await expect(chat.locator(".sc-chat-msg[data-role=user] .sc-chat-tick")).toHaveText("✓✓ Replied")
  await expect(chat.locator(".sc-chat-msg[data-role=user] .sc-chat-chip")).toHaveText("about r3")
  await expect(chat).toContainText("Moved it to the top in r4.")

  // Enter sends once, with this Surface attached; it reads Sent until the session holds it, then Seen, then Replied.
  await chat.locator("textarea").press("Enter")
  await expect.poll(() => prompts().length).toBe(1)
  const sent = prompts()[0].body
  expect(sent.parts[1].text).toContain('"id":"review"')
  await expect(chat.locator(".sc-chat-pending .sc-chat-tick")).toHaveText("✓ Sent")
  const promoted = user(sent.messageID, "Can the summary sit beside the chart?", 4, Date.now())
  preview.fixture.messages.push(promoted)
  preview.fixture.emit("message.updated", { info: promoted.info })
  for (const part of promoted.parts) preview.fixture.emit("message.part.updated", { part })
  preview.fixture.setStatus("busy")
  await expect(chat.locator(".sc-chat-pending")).toHaveCount(0)
  await expect(chat.locator(".sc-chat-msg[data-role=user]").last().locator(".sc-chat-tick")).toHaveText("✓✓ Seen")
  await expect(chat.locator(".sc-chat-working")).toBeVisible()

  // Minimised, a reply counts as unread on the bubble and the chat button; reopening clears it.
  await page.keyboard.press("Escape")
  await expect(chat).toBeHidden()
  await expect(toolbar.locator(".sc-tool-chat")).toBeFocused()
  const answer = reply("msg_9answer", sent.messageID, "Yes: beside it from 1100px up.", Date.now())
  preview.fixture.messages.push(answer)
  preview.fixture.emit("message.updated", { info: answer.info })
  for (const part of answer.parts) preview.fixture.emit("message.part.updated", { part })
  preview.fixture.setStatus("idle")
  await expect(page.locator(".sc-chat-bubble .sc-chat-unread")).toHaveText("1")
  await shot("chat-minimised")
  await page.locator(".sc-chat-bubble").click()
  await expect(chat.locator(".sc-chat-msg[data-role=user]").last().locator(".sc-chat-tick")).toHaveText("✓✓ Replied")
  await expect(page.locator(".sc-chat-unread")).toHaveCount(0)
  await shot("chat-reply")
  // A draft survives closing the pop (× and reopen); the mic and closing never send.
  await chat.locator("textarea").fill("Unsent thought")
  await chat.getByRole("button", { name: "Close chat" }).click()
  await expect(chat).toHaveCount(0)
  await expect(toolbar.locator(".sc-tool-chat")).toBeFocused()
  await page.keyboard.press("m")
  await expect(page.locator(".sc-chat textarea")).toHaveValue("Unsent thought")
  await page.locator(".sc-chat").getByRole("button", { name: "Close chat" }).click()
  expect(prompts()).toHaveLength(1)
  expect(errors).toEqual([])
  await context.close()

  // An author with no readable chat on this host says why and cannot send (DD #1307 (2)).
  preview.fixture.laneOwners = []
  {
    const other = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const view = await other.newPage()
    for (const [pattern, handler] of [[(url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } })], ["**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } })],
      ["**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" }, body: PAGE })], [(url) => new URL(url).pathname === "/es/api/surfaces/review/comments", (route) => route.fulfill({ json: { comments: [] } })]]) await view.route(pattern, handler)
    await view.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
    await view.locator(".sc-tool-chat").click()
    await expect(view.locator(".sc-chat")).toContainText("not listed")
    await view.locator(".sc-chat textarea").fill("hello")
    await expect(view.locator(".sc-chat .sc-chat-send")).toBeDisabled()
    await expect(view.locator(".sc-chat-msg")).toHaveCount(0)
    await other.close()
  }
  preview.fixture.laneOwners = [{ lane: "ux-feel", owner: "ses_a" }]
  // Phone: the chat fits the stage above the toolbar.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: shots ? 2 : 1 })
  const small = await phone.newPage()
  for (const [pattern, handler] of [[(url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } })], ["**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } })],
    ["**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" }, body: PAGE })], [(url) => new URL(url).pathname === "/es/api/surfaces/review/comments", (route) => route.fulfill({ json: { comments: [] } })]]) await small.route(pattern, handler)
  await small.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await small.locator(".sc-tool-chat").click()
  const box = await small.locator(".sc-chat").boundingBox(), bar = await small.locator(".sc-toolbar").boundingBox()
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y)
  if (shots) await small.locator(".surface-stage").screenshot({ path: path.join(shots, "chat-phone.png") })
  await phone.close()
  console.log("surface-chat: PASS")
} finally {
  await browser.close()
  await preview.close()
}

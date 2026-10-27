// A delivered Send is shown exactly once. Its outgoing "Sent" bubble is removed when the transcript shows
// the message with the same client message ID, even when the message also carries context parts (as a send
// from a surface does), when it arrives before the POST answer, after a lost answer and reload, or when an
// earlier message has identical text. Nothing is resent; an undelivered send keeps its bubble.
// Run from packages/es-app: node test/sent-echo-identity.browser.mjs   (ECHO_SHOTS=<dir> for screenshots)
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const editor = page.getByRole("textbox", { name: "Message", exact: true })
const ghost = page.locator(".outgoing .outgoing-msg[aria-label='Message status']")
const posts = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/prompt_async")
const users = (text) => page.locator('[data-component="user-message"]').filter({ hasText: text })
const shot = async (name) => { if (process.env.ECHO_SHOTS) await page.screenshot({ path: `${process.env.ECHO_SHOTS}/${name}.png` }) }
// The host's projection of a prompt: the typed text, plus a synthetic part for each attached context.
const project = (body, context) => {
  const id = body.messageID
  const info = { id, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } }
  const parts = [{ id: `prt_${id}`, sessionID: "ses_a", messageID: id, type: "text", text: body.parts[0].text },
    ...(context ? [{ id: `prt_${id}_ctx`, sessionID: "ses_a", messageID: id, type: "text", text: context, synthetic: true }] : [])]
  fixture.messages.push({ info, parts })
  fixture.emit("message.updated", { info })
  for (const part of parts) fixture.emit("message.part.updated", { part })
}
const send = async (text) => {
  await editor.fill(text)
  await page.getByRole("button", { name: "Send", exact: true }).click()
}
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.locator(".session-work-status:visible")).toHaveAttribute("data-state", "idle")

  // 1. Accepted send whose message carries surface context: the bubble goes once the message is shown.
  await send("the interactive buttons on the surface dont seem to work")
  await expect(ghost.locator(".outgoing-cue > span")).toHaveText("Sent")
  project(posts()[0].body, "<surface>Squadron v2 · buttons: Approve, Reject</surface>")
  await expect(users("the interactive buttons on the surface dont seem to work")).toHaveCount(1)
  await expect(ghost).toHaveCount(0)
  await shot("1-context")
  console.info("PASS send with context parts: exactly one representation once the canonical message is shown")

  // 2. Canonical message before the POST answer: no bubble once it is shown, none after the answer.
  fixture.holdNormal = true
  await send("message arrives before its acknowledgment")
  await expect(ghost.locator(".outgoing-cue > span")).toHaveText("Sending…")
  await expect.poll(() => posts().length).toBe(2)
  project(posts()[1].body)
  await expect(users("message arrives before its acknowledgment")).toHaveCount(1)
  await expect(ghost).toHaveCount(0)
  fixture.holdNormal = false
  fixture.normalReplies.splice(0).forEach((reply) => reply())
  await page.waitForTimeout(500)
  await expect(ghost).toHaveCount(0)
  await expect(users("message arrives before its acknowledgment")).toHaveCount(1)
  console.info("PASS message before POST answer: one representation before and after the answer")

  // 3. Lost answer: Not confirmed with the draft back in the editor; the message then appears (and after a
  // reload) -> confirmed by ID, the bubble and the restored draft go, nothing is resent.
  fixture.loseNormal = true
  await send("answer lost but it landed")
  await expect(ghost.locator(".outgoing-cue > span")).toHaveText(/^Not confirmed/)
  await expect(editor).toHaveValue("answer lost but it landed")
  const lost = posts()[2].body
  fixture.loseNormal = false
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(ghost.locator(".outgoing-cue > span")).toHaveText(/^Not confirmed/)
  project(lost)
  await expect(users("answer lost but it landed")).toHaveCount(1)
  await expect(ghost).toHaveCount(0)
  await expect(editor).toHaveValue("")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(users("answer lost but it landed")).toHaveCount(1)
  await expect(ghost).toHaveCount(0)
  expect(posts()).toHaveLength(3)
  console.info("PASS lost answer + reload: confirmed by ID when shown; bubble and restored draft cleared; no resend")

  // 4. Two intentionally identical messages: the second keeps its own bubble until its own message is shown.
  await send("same text twice")
  await expect.poll(() => posts().length).toBe(4)
  project(posts()[3].body)
  await expect(users("same text twice")).toHaveCount(1)
  await expect(ghost).toHaveCount(0)
  await send("same text twice")
  await expect(ghost.locator(".outgoing-cue > span")).toHaveText("Sent")
  await expect.poll(() => posts().length).toBe(5)
  await page.waitForTimeout(500)
  await expect(ghost).toHaveCount(1)
  project(posts()[4].body)
  await expect(users("same text twice")).toHaveCount(2)
  await expect(ghost).toHaveCount(0)
  await shot("4-identical")
  expect(new Set(posts().map((call) => call.body.messageID)).size).toBe(5)
  console.info("PASS identical text: the earlier message does not settle the later send; each shown once")

  // 5. An accepted send whose message has not been shown keeps its bubble.
  await send("not shown yet")
  await page.waitForTimeout(800)
  await expect(ghost.locator(".outgoing-cue > span")).toHaveText("Sent")
  console.info("PASS accepted but not yet in the transcript: Sent bubble kept")
  expect(errors).toEqual([])
  expect(fixture.unexpected).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

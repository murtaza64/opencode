// es-app scroll: returning to a session that changed while away lands on the latest message and
// stays there while the snapshot, streamed updates, grouping and the first-mount window settle.
// A reader who scrolled up keeps their place. Frames are sampled to catch any visible jump.
// Run from packages/es-app: node test/session-return-pin.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "busy"
const assistant = (id, parent, turn, extra = {}) => ({
  id, sessionID: "ses_a", role: "assistant", parentID: parent, agent: "build", mode: "build", providerID: "fixture", modelID: "test",
  path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: turn * 1000 + 1, completed: turn * 1000 + 999 }, finish: "stop", ...extra,
})
const turn = (index) => {
  const user = `msg_${String(index * 2).padStart(6, "0")}`, reply = `msg_${String(index * 2 + 1).padStart(6, "0")}`
  return [
    { info: { id: user, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: index * 1000 } },
      parts: [{ id: `prt_${user}`, messageID: user, sessionID: "ses_a", type: "text", text: `Request ${index}` }] },
    { info: assistant(reply, user, index),
      parts: [
        ...[0, 1, 2].map((call) => ({ id: `prt_${reply}_t${call}`, messageID: reply, sessionID: "ses_a", type: "tool", callID: `c_${index}_${call}`, tool: "bash",
          state: { status: "completed", input: { command: `step ${call}` }, output: "ok\n".repeat(8), title: "bash", metadata: {}, time: { start: 1, end: 2 } } })),
        { id: `prt_${reply}_x`, messageID: reply, sessionID: "ses_a", type: "text",
          text: `Answer ${index}. `.repeat(40) + "\n\n```ts\n" + Array.from({ length: 12 }, (_, line) => `const value${line} = compute(${line}) // ${index}`).join("\n") + "\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n" },
      ] },
  ]
}
fixture.messages = Array.from({ length: 60 }, (_, index) => turn(index)).flat()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const open = async (id) => {
  await page.locator(`.nav-item[href*="${id}"]`).first().click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${id}`)
}
// Records distance from the bottom as painted: our ResizeObserver is registered after the app's,
// so in each frame where the transcript changed size it reads after the app's pin and before paint.
const sample = () => page.evaluate(() => {
  window.__gaps = []
  const el = document.querySelector(".session-main .transcript")
  window.__observer?.disconnect()
  window.__watch = () => {
    const transcript = document.querySelector(".session-main .transcript")
    const inner = transcript?.querySelector(".transcript-inner")
    if (!inner || inner === window.__inner) return
    window.__inner = inner
    window.__observer?.disconnect()
    window.__observer = new ResizeObserver(() => window.__gaps.push(Math.round(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight)))
    window.__observer.observe(inner)
  }
  window.__sampling = setInterval(window.__watch, 5)
})
const stop = () => page.evaluate(() => { clearInterval(window.__sampling); window.__observer?.disconnect(); return window.__gaps })
const emitTurn = (index) => {
  for (const message of turn(index)) {
    fixture.emit("message.updated", { info: message.info })
    for (const part of message.parts) fixture.emit("message.part.updated", { part })
  }
  fixture.messages.push(...turn(index))
}
const cdp = await page.context().newCDPSession(page)
try {
  await page.goto(preview.url, { timeout: 300_000 })
  if (process.env.THROTTLE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.THROTTLE) })
  await expect(page.getByText("Answer 59.").first()).toBeVisible()
  await page.waitForTimeout(1500)

  // 1. Away on B while A gets three new turns; the return snapshot is held (slow daemon).
  await open("ses_b")
  // While away: completed turns plus a long streamed reply on A.
  for (let index = 60; index < 63; index++) emitTurn(index)
  const stream = { id: "msg_000999", part: "prt_msg_000999_x" }
  fixture.emit("message.updated", { info: assistant(stream.id, "msg_000124", 63, { time: { created: 63_000 } }) })
  fixture.emit("message.part.updated", { part: { id: stream.part, messageID: stream.id, sessionID: "ses_a", type: "text", text: "" } })
  const streaming = setInterval(() => fixture.emit("message.part.delta", { sessionID: "ses_a", messageID: stream.id, partID: stream.part, field: "text", delta: "more streamed words, ".repeat(4) + "\n" }), 40)
  fixture.holdMessages.set("ses_a", true)
  if (process.env.DEBUG_SCROLL) await page.evaluate(() => { window.__debug = true })
  await sample()
  await open("ses_a")
  await expect(page.getByText("Answer 62.").first()).toBeVisible()
  await page.waitForTimeout(1500)
  fixture.holdMessages.delete("ses_a")
  fixture.messageReplies.splice(0).forEach((release) => release())
  // A streamed turn after arrival, while the first-mount window keeps mounting older rows.
  emitTurn(63)
  await page.waitForTimeout(2500)
  clearInterval(streaming)
  const returned = await stop()
  const settled = returned.slice(1)
  console.info(`return: frames=${returned.length} max-gap-after-first-paint=${Math.max(...settled)} jumps>40px=${settled.filter((gap) => gap > 40).length}`)
  expect(Math.max(...settled)).toBeLessThanOrEqual(40)
  await expect(page.getByText("Answer 63.").first()).toBeInViewport()
  console.info("PASS return to an updated session: stays at the latest message through held snapshot, new turns and mount window")

  // 2. A reader who scrolled up keeps their place while updates arrive.
  await page.locator(".session-main .transcript").hover()
  await page.mouse.wheel(0, -1500)
  await page.waitForTimeout(300)
  const reading = await page.locator(".session-main .transcript").evaluate((el) => el.scrollTop)
  emitTurn(64)
  await page.waitForTimeout(1500)
  const after = await page.locator(".session-main .transcript").evaluate((el) => el.scrollTop)
  expect(Math.abs(after - reading)).toBeLessThanOrEqual(2)
  console.info("PASS scrolled-up reader keeps their place while new turns arrive")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

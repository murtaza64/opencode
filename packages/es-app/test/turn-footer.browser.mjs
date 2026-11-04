// One footer per agent turn (transcript-agent-message-completion-times-20261103). A finished turn shows one footer:
// when it completed (viewer-local clock + relative age), then agent, model and turn duration; hover/aria give the turn
// start, reply start and completion exactly. The reply's own session-ui meta line is not shown, so there is no second
// "Agent · model-id · Ns" line. An interrupted turn says so. Viewed under New York and UTC.
// Run from packages/es-app: node test/turn-footer.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const prompt = Date.UTC(2026, 10, 3, 15, 0, 0)
const assistant = (id, parentID, created, completed, extra = {}) => ({ info: { id, parentID, sessionID: "ses_a", role: "assistant", agent: "implement", mode: "implement", providerID: "fixture", modelID: "test",
  path: { cwd: directory, root: directory }, time: { created, completed }, finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra },
  parts: [{ id: `${id}_t`, messageID: id, sessionID: "ses_a", type: "text", text: `Reply ${id}`, time: { start: created, end: completed } }] })
fixture.messages = [
  { info: { id: "msg_1u", sessionID: "ses_a", role: "user", agent: "implement", model: { providerID: "fixture", modelID: "test" }, time: { created: prompt } },
    parts: [{ id: "prt_1u", messageID: "msg_1u", sessionID: "ses_a", type: "text", text: "do it" }] },
  assistant("msg_2a", "msg_1u", prompt + 10_000, prompt + 132_000),
  assistant("msg_3a", "msg_1u", prompt + 132_000, prompt + 161_000),
  { info: { id: "msg_4u", sessionID: "ses_a", role: "user", agent: "implement", model: { providerID: "fixture", modelID: "test" }, time: { created: prompt + 300_000 } },
    parts: [{ id: "prt_4u", messageID: "msg_4u", sessionID: "ses_a", type: "text", text: "and this" }] },
  assistant("msg_5a", "msg_4u", prompt + 301_000, prompt + 305_000, { error: { name: "MessageAbortedError", data: { message: "aborted" } } }),
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  for (const [zone, clock] of [["America/New_York", /10:02/], ["UTC", /15:02|03:02/]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: zone })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
    const turn = page.locator('[data-find-message="msg_3a"]')
    await expect(turn).toContainText("Reply msg_3a", { timeout: 120_000 })
    // One footer for the turn; no second meta line under the reply.
    await expect(page.locator(".turn-summary")).toHaveCount(2)
    await expect(page.locator('.session-page [data-slot="text-part-meta"]:visible')).toHaveCount(0)
    const footer = turn.locator(".turn-summary")
    await expect(footer).toContainText(clock)
    await expect(footer).toContainText("Implement")
    await expect(footer).toContainText("2m 41s")
    const time = footer.locator("time.turn-time")
    const exact = await time.getAttribute("title")
    expect(exact).toMatch(zone === "UTC" ? /Turn started .*exact: 2026-11-03T15:00:00Z.*reply started .*15:02:12Z.*completed .*15:02:41Z/ : /Turn started .*-05:00.*reply started .*completed .*10:02:41-05:00/)
    expect(await time.getAttribute("aria-label")).toBe(exact)
    // Interrupted turn says so with its time.
    await expect(page.locator('[data-find-message="msg_5a"] .turn-summary time')).toContainText("interrupted")
    await context.close()
  }
  expect(errors).toEqual([])
  console.log("PASS turn footer: one footer per turn with completion time (viewer-local, relative) then agent/model/duration; exact start/reply/completion on hover and aria; no duplicate session-ui meta; interrupted labelled; New York and UTC")
} finally {
  await preview.close()
  await browser.close()
}

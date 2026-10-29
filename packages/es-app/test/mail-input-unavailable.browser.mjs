// CHAT07: a mail input stored in the session stays in the transcript when its mail record cannot be read (no mail
// scope for this directory on this host, a failed read, or a feed without the record). The chip shows sender and
// kind from the stored input, says the record is unavailable, and claims no wake or delivery. With the record, the
// same input renders once, with its wake evidence.
// Run from packages/es-app: node test/mail-input-unavailable.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const sent = 50
fixture.messages.push(
  { info: { id: "msg_zmail", sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: sent },
    source: { type: "editspace-mail", id: "work#85", sender: "designer", recipient: "work", kind: "task" } },
    parts: [{ id: "part_zmail", messageID: "msg_zmail", sessionID: "ses_a", type: "text", text: "Kit PR 2 of 3 is up." }] },
  { info: { id: "msg_zreply", parentID: "msg_zmail", sessionID: "ses_a", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, time: { created: sent + 1, completed: sent + 2 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{ id: "part_zreply", messageID: "msg_zreply", sessionID: "ses_a", type: "text", text: "Taking screenshots of the PR." }] },
)
const record = { id: "work#85", ts: new Date(sent).toISOString(), created_ms: sent, from: "designer", to: "work", direction: "received", kind: "task",
  text: "Kit PR 2 of 3 is up.", deliveries: [{ message_id: "work#85", recipient: "work", session: "ses_a", mode: "actionable", state: "handled",
    request_id: null, error: null, presented_at: null, handled_at: null, wake: "caused", wake_observations: [{ outcome: "scheduled", observedAt: sent }] }] }
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const open = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.context().route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(page.getByText("Taking screenshots of the PR.")).toBeVisible({ timeout: 30_000 })
  return page
}
const chip = (page) => page.locator('.mail-activity[data-mail-message-id="msg_zmail"]')
try {
  // 1. The mail read fails (the fixture answers 404): the input stays, from its stored source, with no wake claim.
  fixture.mail = undefined
  let page = await open()
  await expect(chip(page)).toHaveCount(1)
  await expect(chip(page).locator(".mail-activity-summary")).toHaveAccessibleName(/^Mail from designer: Task/)
  await expect(chip(page).locator(".mail-activity-summary")).not.toHaveAttribute("data-wake", /.+/)
  await chip(page).locator(".mail-activity-summary").click()
  await expect(chip(page).locator(".mail-record-unavailable")).toHaveText("Mail record not available on this host. Sender and kind are from the stored input.")
  await expect(chip(page).locator(".mail-activity-details")).not.toContainText(/scheduled|Woke|wake/i)
  await page.close()

  // 2. The feed loads but lacks the record: still visible, still no claim.
  fixture.mail = (es, recipient) => ({ editspace: es, lane: "", messages: [] })
  page = await open()
  await expect(chip(page)).toHaveCount(1)
  await page.close()

  // 3. The record is in the feed: one chip (no second standalone mail row) with its wake evidence.
  fixture.mail = (es, recipient) => ({ editspace: es, lane: "", messages: recipient === "ses_a" ? [record] : [] })
  page = await open()
  await expect(chip(page)).toHaveCount(1)
  await expect(page.locator('.mail-activity[data-mail-id="work#85"]')).toHaveCount(0)
  await expect(chip(page).locator(".mail-activity-summary")).toHaveAttribute("data-wake", "caused")
  await chip(page).locator(".mail-activity-summary").click()
  await expect(chip(page).locator(".mail-record-unavailable")).toHaveCount(0)
  await page.close()

  expect(errors).toEqual([])
  console.log("PASS mail input visible without its record (failed read, feed without record), no wake claim; with its record one chip with wake evidence, no duplicate")
} finally {
  await preview.close()
  await browser.close()
}

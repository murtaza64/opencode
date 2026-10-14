import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const directory = `${fixture.editspaces[0].root}/lanes/lane-alpha/repos/org/repo`
const ts = "2026-10-13T12:00:00Z"
const delivery = { message_id: "mail-a", recipient: "lane-alpha", session: "ses_a", mode: "queue", state: "read", request_id: "req-1", error: null, presented_at: ts, handled_at: null }
const outbound = { message_id: "mail-b", recipient: "lane-beta", session: "ses_b", mode: "steer", state: "pending", request_id: "req-2", error: null, presented_at: null, handled_at: null }
fixture.messages = [{
  info: { id: "msg_promoted", sessionID: "ses_a", role: "user", agent: "build", time: { created: Date.parse(ts) + 120000 },
    source: { type: "editspace-mail", id: "mail-c", sender: "lane-beta", recipient: "lane-alpha" }, delivery: "queue", state: "promoted" },
  parts: [{ id: "part_promoted", messageID: "msg_promoted", sessionID: "ses_a", type: "text", text: "Promoted body" }],
}]
fixture.mail = (es, lane) => {
  if (es !== "fixture" || lane !== "lane-alpha") return { editspace: es, lane, messages: [] }
  return { editspace: es, lane, messages: [
    { id: "mail-a", ts, from: "lane-beta", to: "lane-alpha", direction: "received", kind: "update", text: "First line\n<img src=x onerror=alert(1)>", deliveries: [delivery] },
    { id: "mail-b", ts: "2026-10-13T12:01:00Z", from: "lane-alpha", to: "lane-beta", direction: "sent", text: "Reply", in_reply_to: "mail-a", deliveries: [outbound, { ...outbound, recipient: "lane-gamma", request_id: "req-3", state: "handled" }] },
    { id: "mail-c", ts: "2026-10-13T12:02:00Z", from: "lane-beta", to: "lane-alpha", direction: "received", text: "Promoted body", deliveries: [{ ...delivery, message_id: "mail-c", state: "handled" }] },
  ] }
}
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
try {
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator('[data-mail-id="mail-a"]')).toHaveCount(1)
  await expect(page.locator('[data-mail-id="mail-b"]')).toHaveCount(1)
  await expect(page.locator('[id="mail-mail-c"]')).toHaveCount(1)
  await expect(page.locator('[data-mail-id="mail-c"]')).toHaveCount(0)
  await page.locator('[id="mail-mail-c"] summary').click()
  await expect(page.locator('[id="mail-mail-c"] summary')).toContainText("Inbound")
  await expect(page.locator('[id="mail-mail-c"]')).toContainText("Promoted body")
  await expect(page.locator('[id="mail-mail-c"]')).toContainText("Sent:")
  await expect(page.locator('[id="mail-mail-c"]')).toContainText("To lane-alpha · queue · handled")
  await expect(page.locator('[data-mail-id="mail-a"] summary')).toContainText("Inbound")
  await expect(page.locator('[data-mail-id="mail-a"] summary')).toContainText("read")
  await page.locator('[data-mail-id="mail-a"] summary').click()
  await expect(page.locator('[data-mail-id="mail-a"] .mail-activity-body')).toContainText("<img src=x onerror=alert(1)>")
  await expect(page.locator('[data-mail-id="mail-a"] img')).toHaveCount(0)
  await expect(page.locator('[data-mail-id="mail-a"]')).toContainText("Presented:")
  await page.locator('[data-mail-id="mail-b"] summary').click()
  await expect(page.locator('[data-mail-id="mail-b"] summary')).toContainText("Outbound")
  await expect(page.locator('[data-mail-id="mail-b"] .mail-delivery')).toHaveCount(2)
  await expect(page.locator('[data-mail-id="mail-b"]')).toContainText("To lane-beta · steer · pending")
  await expect(page.locator('[data-mail-id="mail-b"]')).toContainText("To lane-gamma · steer · handled")
  await expect(page.locator('[data-mail-id="mail-b"] a[href="#mail-mail-a"]')).toHaveCount(1)
  delivery.state = "handled"
  delivery.handled_at = "2026-10-13T12:02:00Z"
  fixture.emitDashboard("mail")
  await expect(page.locator('[data-mail-id="mail-a"] summary')).toContainText("handled")
  await expect(page.locator('[data-mail-id="mail-a"]')).toContainText("Handled:")
  expect(fixture.calls.filter(call => call.path === "/api/mail").length).toBeGreaterThanOrEqual(2)
  // Lineage: ses_a handed the lane to ses_b. Each transcript shows only mail delivered to or sent by
  // that session; the lane mail view keeps the whole feed.
  fixture.handoffs = [{ lane: "lane-alpha", predecessor: "ses_a", successor: "ses_b" }]
  fixture.messages = []
  fixture.mail = (es, lane) => ({ editspace: es, lane, messages: lane !== "lane-alpha" ? [] : [
    { id: "mail-a", ts, from: "lane-beta", to: "lane-alpha", direction: "received", text: "Before handoff", deliveries: [{ ...delivery, session: "ses_a" }] },
    { id: "mail-b", ts: "2026-10-13T12:01:00Z", from: "lane-alpha", to: "lane-beta", direction: "sent", sender_session: "ses_a", text: "Reply", deliveries: [outbound] },
    { id: "mail-d", ts: "2026-10-13T12:05:00Z", from: "lane-beta", to: "lane-alpha", direction: "received", text: "After handoff", deliveries: [{ ...delivery, message_id: "mail-d", session: "ses_b", presented_at: "2026-10-13T12:05:30Z" }] },
    { id: "mail-e", ts: "2026-10-13T12:06:00Z", from: "lane-alpha", to: "lane-beta", direction: "sent", sender_session: "ses_b", text: "Successor reply", deliveries: [] },
  ] })
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator('.transcript [data-mail-id="mail-a"]')).toHaveCount(1)
  await expect(page.locator('.transcript [data-mail-id="mail-b"]')).toHaveCount(1)
  await expect(page.locator('.transcript [data-mail-id="mail-d"]')).toHaveCount(0)
  await expect(page.locator('.transcript [data-mail-id="mail-e"]')).toHaveCount(0)
  await expect(page.locator(".handoff-crumb")).toContainText(["successor (lane-alpha): ses_b"])
  await page.getByRole("button", { name: "Lane mail (4)" }).click()
  await expect(page.locator('.lane-mail [data-mail-id]')).toHaveCount(4)
  await expect(page.locator('.lane-mail [id="lane-mail-mail-d"]')).toHaveCount(1)
  await page.getByRole("button", { name: "Hide lane mail" }).click()
  await expect(page.locator(".lane-mail")).toHaveCount(0)
  await page.goto(`${preview.origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator('.transcript [data-mail-id="mail-d"]')).toHaveCount(1)
  await expect(page.locator('.transcript [data-mail-id="mail-e"]')).toHaveCount(1)
  await expect(page.locator('.transcript [data-mail-id="mail-a"]')).toHaveCount(0)
  await expect(page.locator('.transcript [data-mail-id="mail-b"]')).toHaveCount(0)
  await expect(page.locator(".handoff-crumb")).toContainText(["predecessor (lane-alpha): ses_a"])
  fixture.handoffs = undefined
  fixture.mail = (es, recipient) => ({ editspace: es, lane: "", messages: recipient === "ses_a" ? [
    { id: "parent-mail", ts, from: "reviewer", to: "ses_a", direction: "received", text: "Review ready", deliveries: [
      { ...delivery, message_id: "parent-mail", recipient: "ses_a", session: "ses_a" },
    ] },
  ] : [] })
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(fixture.editspaces[0].root.slice(0, -"/.editspace".length))}`)
  await expect(page.locator('[data-mail-id="parent-mail"]')).toHaveCount(1)
  expect(fixture.calls.some(call => call.path === "/api/mail" && call.es === "fixture" && call.recipientSession === "ses_a")).toBe(true)
  expect(errors).toEqual([])
  console.log("PASS mail timeline: scoped fetch, read/handled invalidation, ordered rows, safe body and links, lineage scoping with lane mail view")
} finally {
  await browser.close()
  await preview.close()
}

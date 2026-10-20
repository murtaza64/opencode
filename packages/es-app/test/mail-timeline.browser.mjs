import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const directory = `${fixture.editspaces[0].root}/lanes/lane-alpha/repos/org/repo`
const ts = "2026-10-13T12:00:00Z"
fixture.sessionTimes.set("ses_a", { created: Date.parse(ts), updated: Date.parse(ts) })
fixture.sessionTimes.set("ses_b", { created: Date.parse(ts) + 240000, updated: Date.parse(ts) + 240000 })
const delivery = { message_id: "mail-a", recipient: "lane-alpha", session: "ses_a", mode: "queue", state: "read", request_id: "req-1", error: null, presented_at: ts, handled_at: null }
const outbound = { message_id: "mail-b", recipient: "lane-beta", session: "ses_b", mode: "steer", state: "pending", request_id: "req-2", error: null, presented_at: null, handled_at: null }
fixture.messages = [{
  info: { id: "msg_promoted", sessionID: "ses_a", role: "user", agent: "build", time: { created: Date.parse(ts) + 120000 },
    source: { type: "editspace-mail", id: "mail-c", sender: "lane-beta", recipient: "lane-alpha" }, delivery: "queue", state: "promoted" },
  parts: [{ id: "part_promoted", messageID: "msg_promoted", sessionID: "ses_a", type: "text", text: "Promoted body" }],
}, {
  info: { id: "msg_historical", sessionID: "ses_a", role: "user", time: { created: Date.parse(ts) + 180000 },
    source: { type: "editspace-mail", id: "old-promoted", sender: "lane-beta", recipient: "lane-alpha" } },
  parts: [{ id: "part_historical", messageID: "msg_historical", sessionID: "ses_a", type: "text", text: "HISTORICAL_PROMOTED_SENTINEL" }],
}]
fixture.mail = (es, lane) => {
  if (es !== "fixture" || lane !== "lane-alpha") return { editspace: es, lane, messages: [] }
  return { editspace: es, lane, messages: [
    { id: "mail-a", ts, from: "lane-beta", to: "lane-alpha", direction: "received", kind: "update", text: "First line\n<img src=x onerror=alert(1)>", deliveries: [delivery] },
    { id: "mail-b", ts: "2026-10-13T12:01:00Z", from: "lane-alpha", to: "lane-beta", direction: "sent", text: "Reply", in_reply_to: "mail-a", deliveries: [outbound, { ...outbound, recipient: "lane-gamma", request_id: "req-3", state: "handled" }] },
    { id: "mail-c", ts: "2026-10-13T12:02:00Z", from: "lane-beta", to: "lane-alpha", direction: "received", text: "Promoted body", deliveries: [{ ...delivery, message_id: "mail-c", state: "handled" }] },
    { id: "old-promoted", ts: "2026-10-13T11:59:59Z", from: "lane-beta", to: "lane-alpha", direction: "received", text: "HISTORICAL_PROMOTED_SENTINEL", deliveries: [{ ...delivery, presented_at: "2026-10-13T12:03:00Z" }] },
    { id: "invalid-time", ts: "invalid", from: "lane-beta", to: "lane-alpha", direction: "received", text: "INVALID_TIME_SENTINEL", deliveries: [delivery] },
  ] }
}
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
let releaseMetadata
const metadataGate = new Promise(resolve => { releaseMetadata = resolve })
await page.route(url => url.pathname === "/oc/session/ses_a", async route => {
  const response = await route.fetch()
  await metadataGate
  await route.fulfill({ response })
})
try {
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect.poll(() => fixture.calls.filter(call => call.path === "/api/mail").length).toBeGreaterThanOrEqual(2)
  await expect(page.locator('.transcript [data-mail-id]')).toHaveCount(0)
  releaseMetadata()
  await expect(page.locator('[data-mail-id="mail-a"]')).toHaveCount(1)
  await expect(page.locator('.transcript')).not.toContainText("HISTORICAL_PROMOTED_SENTINEL")
  await expect(page.locator('.transcript')).not.toContainText("INVALID_TIME_SENTINEL")
  expect(fixture.messages).toHaveLength(2)
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
  await expect(page.locator('[data-mail-id="mail-a"] summary')).toContainText("Wake/resume unknown")
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
  await expect(page.getByLabel("Previous session")).toContainText("ses_a")
  fixture.handoffs = undefined
  fixture.mail = (es, recipient) => ({ editspace: es, lane: "", messages: recipient === "ses_a" ? [
    { id: "parent-mail", ts, from: "reviewer", to: "ses_a", direction: "received", text: "Review ready", deliveries: [
      { ...delivery, message_id: "parent-mail", recipient: "ses_a", session: "ses_a" },
    ] },
  ] : [] })
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(fixture.editspaces[0].root.slice(0, -"/.editspace".length))}`)
  await expect(page.locator('[data-mail-id="parent-mail"]')).toHaveCount(1)
  expect(fixture.calls.some(call => call.path === "/api/mail" && call.es === "fixture" && call.recipientSession === "ses_a")).toBe(true)
  // Durable records, not shell text/stdout, drive every outgoing chip, including a partial loop.
  const failedShell = {
    id: "shell-part", sessionID: "ses_a", messageID: "msg_shell", type: "tool", callID: "call_loop", tool: "bash",
    state: { status: "error", input: { command: "for lane in a b c d; do es mail send --kind task --to $lane work; done" }, error: "zsh: partial loop failed", time: { start: Date.parse(ts) + 1000, end: Date.parse(ts) + 2000 } },
  }
  fixture.messages = [{ info: { id: "msg_shell", sessionID: "ses_a", parentID: "msg_1", role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, time: { created: Date.parse(ts) + 1000, completed: Date.parse(ts) + 2000 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [failedShell] }]
  fixture.mail = (es, recipient) => ({ editspace: es, lane: "", messages: recipient === "ses_a" ? [1, 2, 3, 4].map(index => ({
    id: `loop-${index}`, ts, created_ms: Date.parse(ts) + 1100 + index,
    from: "orchestrator", to: `مراجعة-long-lane-${index}`, sender_session: "ses_a", origin_run: "run", origin_tool_call: "call_loop", direction: "sent", kind: "task", text: `Actual durable send ${index}`, deliveries: [],
  })) : [] })
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator('.transcript [data-mail-id]')).toHaveCount(4)
  await page.locator('[data-kind="tool-error-card"] button').first().click()
  await expect(page.locator('.transcript')).toContainText("partial loop failed")
  fixture.emitDashboard("mail")
  await expect(page.locator('.transcript [data-mail-id]')).toHaveCount(4)
  await page.locator('[data-mail-id="loop-1"] summary').focus()
  await page.keyboard.press("Enter")
  await expect(page.locator('[data-mail-id="loop-1"]')).toHaveAttribute("open", "")
  await expect(page.locator('[data-mail-id="loop-1"]')).toContainText("Origin tool call: call_loop")
  for (const dir of ["ltr", "rtl"]) {
    await page.evaluate(dir => { document.documentElement.dir = dir }, dir)
    await page.setViewportSize({ width: 800, height: 900 })
    expect(await page.locator('[data-mail-id="loop-1"]').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(await page.locator('[data-mail-id="loop-1"] .mail-activity-arrow').evaluate(el => getComputedStyle(el).transform))
      .toBe(dir === "rtl" ? "matrix(-1, 0, 0, 1, 0, 0)" : "none")
  }
  const fourSends = fixture.mail
  fixture.mail = (es, recipient) => ({ ...fourSends(es, recipient), messages: fourSends(es, recipient).messages.slice(0, 2) })
  fixture.emitDashboard("mail")
  await expect(page.locator('.transcript [data-mail-id]')).toHaveCount(2)
  await expect(page.locator('.transcript')).toContainText("partial loop failed")
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(fixture.editspaces[0].root)}`)
  await expect(page.locator('.transcript [data-mail-id]')).toHaveCount(2)
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(`${fixture.editspaces[0].root}/repos/org/repo`)}`)
  await expect(page.locator('.transcript [data-mail-id]')).toHaveCount(2)
  await page.goto(`${preview.origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator('.transcript [data-mail-id]')).toHaveCount(0)
  expect(errors).toEqual([])
  console.log("PASS mail timeline: source-time/metadata boundaries, raw history retained, lineage, independent/root-mirror sessions, durable four-send/partial-loop replay, tool error, keyboard and LTR/RTL details")
} finally {
  await browser.close()
  await preview.close()
}

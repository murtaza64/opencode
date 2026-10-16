import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const user = (id, text, extra = {}) => ({
  info: { ...fixture.messages[0].info, id, ...extra },
  parts: [{ id: `part_${id}`, messageID: id, sessionID: "ses_a", type: "text", text }],
})
fixture.messages = [
  user("msg_001", "Typed by the human", { source: { type: "human", via: "es-app" } }),
  user("msg_002", "Plain human turn"),
  user("msg_003", "Mail body", { source: { type: "editspace-mail", id: "mail-1", sender: "lane-a", recipient: "lane-b" } }),
  user("msg_004", "Continue the brief\nSecond line <img src=x onerror=alert(1)>", { source: { type: "resume", sender: "orchestrator", in_reply_to: "mail-1" } }),
  user("msg_005", "Wake for inbox", { source: { type: "heartbeat", sender: "launchd", schedule: "*/15" } }),
  user("msg_006", "Child finished", { source: { type: "subagent-return", sessionID: "ses_child", agent: "explore" } }),
  user("msg_007", "Malformed claims resume", { source: { type: "resume" } }),
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
try {
  await page.goto(preview.url)
  const human = page.locator('.transcript [data-component="user-message"]:not(.mail-activity [data-component="user-message"])')
  await expect(human).toHaveCount(3)
  await expect(human).toContainText(["Typed by the human", "Plain human turn", "Malformed claims resume"])
  await expect(page.locator('.mail-activity[data-source-category="agent"]')).toHaveCount(3)
  await expect(page.locator('.mail-activity[data-source-category="system"]')).toHaveCount(1)
  const resume = page.locator('[data-sourced-message-id="msg_004"]')
  await expect(resume).toHaveAttribute("data-source-type", "resume")
  await expect(resume.locator("summary")).toContainText("Resume")
  await expect(resume.locator("summary")).toContainText("orchestrator")
  await resume.locator("summary").focus()
  await resume.locator("summary").press("Enter")
  await expect(resume).toContainText("Reply to: mail-1")
  await expect(resume.locator(".mail-activity-body")).toHaveText("Continue the brief\nSecond line <img src=x onerror=alert(1)>")
  await expect(resume.locator("img,script,iframe")).toHaveCount(0)
  const heartbeat = page.locator('[data-sourced-message-id="msg_005"]')
  await expect(heartbeat.locator("summary")).toContainText("Heartbeat")
  const color = (locator) => locator.locator(".mail-activity-kind").evaluate(node => getComputedStyle(node).color)
  const colors = new Set([
    await color(page.locator('[data-mail-message-id="msg_003"]')),
    await color(resume),
    await color(heartbeat),
  ])
  expect(colors.size).toBe(3)
  expect(errors).toEqual([])
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS input source: human bare, mail/agent/system distinct badges, malformed source stays human-styled, safe text, no mutations")
} finally {
  await browser.close()
  await preview.close()
}

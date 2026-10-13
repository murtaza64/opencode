import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const user = (id, text, extra = {}) => ({
  info: { ...fixture.messages[0].info, id, ...extra },
  parts: [{ id: `part_${id}`, messageID: id, sessionID: "ses_a", type: "text", text }],
})
const source = { type: "editspace-mail", id: "mail-42", sender: "lane-alpha", recipient: "lane-beta" }
fixture.messages = [
  user("msg_001", "Human: mail-42 from lane-alpha to lane-beta"),
  user("msg_002", "Synthetic notice is not mail", { source: { type: "other", id: "mail-42", sender: "fake", recipient: "fake" } }),
  user("msg_003", "Mail body with <img src=x onerror=alert(1)>", { source, delivery: "queue", state: "promoted" }),
  user("msg_004", "Mail without delivery metadata", { source: { ...source, id: "mail-43" } }),
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const errors = []
page.on("pageerror", error => errors.push(error.message))
try {
  await page.goto(preview.url)
  const mail = page.locator('[data-mail-message-id="msg_003"]')
  await expect(page.locator(".mail-activity")).toHaveCount(2)
  await expect(page.locator('.transcript [data-component="user-message"]:not(.mail-activity [data-component="user-message"])')).toHaveCount(2)
  await expect(mail.locator("summary")).toContainText("lane-alpha → lane-beta")
  await expect(mail.locator("summary")).toContainText("queue")
  await expect(mail.locator("summary")).toContainText("promoted")
  await expect(mail.locator(".mail-activity-body")).not.toBeVisible()
  await mail.locator("summary").focus()
  await mail.locator("summary").press("Enter")
  await expect(mail).toContainText("Mail ID: mail-42")
  await expect(mail).toContainText("Mail body with")
  await expect(mail.locator('[data-component="user-message"]')).toHaveCount(0)
  await expect(mail.locator("img,script,iframe")).toHaveCount(0)
  await expect(page.locator('[data-mail-message-id="msg_004"] summary')).not.toContainText(/queue|steer|pending|promoted|cancelled/)
  await expect(page.locator('.transcript [data-component="user-message"]:not(.mail-activity [data-component="user-message"])')).toContainText(["Human: mail-42", "Synthetic notice is not mail"])
  expect(errors).toEqual([])
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS mail activity: structured source only, delivery/state, expandable original, safe text, no mutations")
} finally {
  await browser.close()
  await preview.close()
}

// es-app#207/#215: a Send never locks the composer. Held answer -> "Not confirmed" after the
// deadline, composer unlocked, draft and images kept. Lost answer whose message exists -> found by
// its own ID and shown as sent, no second POST. Message absent -> "Send again" only on click, same ID.
// Run from packages/es-app: node test/send-unconfirmed.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const editor = page.getByRole("textbox", { name: "Message", exact: true })
const row = page.getByRole("region", { name: "Message status", exact: true })
const posts = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/prompt_async")
const echo = (body) => fixture.messages.push({
  info: { id: body.messageID, sessionID: "ses_a", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: Date.now() } },
  parts: [{ id: `prt_${body.messageID}`, sessionID: "ses_a", messageID: body.messageID, type: "text", text: body.parts[0].text }],
})
try {
  await page.goto(preview.url, { timeout: 90_000 })
  await expect(page.locator(".session-work-status:visible")).toHaveAttribute("data-state", "idle")

  // 1. Held answer: unlocks after the deadline.
  fixture.holdNormal = true
  await editor.fill("held send")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator(".session-work-status:visible")).toContainText("Sending your message")
  await expect(row).toContainText("Not confirmed", { timeout: 40_000 })
  await expect(editor).toHaveValue("held send")
  await expect(editor).toBeEditable()
  await expect(page.locator(".direct-feedback")).toHaveCount(0)
  const held = posts()[0].body
  expect(held.messageID).toMatch(/^msg_/)
  fixture.holdNormal = false
  fixture.normalReplies.splice(0)
  console.info("PASS held answer: Not confirmed after the deadline, composer editable, draft kept")

  // The held POST actually landed: a check by its ID shows it as sent, with no second POST.
  echo(held)
  await row.getByRole("button", { name: "Check", exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(editor).toHaveValue("")
  expect(posts()).toHaveLength(1)
  console.info("PASS lost answer with the message present: reconciled by ID, no duplicate")

  // 2. Lost answer, message absent: explicit Send again with the same ID.
  fixture.loseNormal = true
  await editor.fill("never landed")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(row.getByRole("button", { name: "Send again", exact: true })).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(6000)
  expect(posts()).toHaveLength(2)
  await row.getByRole("button", { name: "Send again", exact: true }).click()
  await expect(row).toHaveCount(0)
  expect(posts()).toHaveLength(3)
  expect(posts()[2].body.messageID).toBe(posts()[1].body.messageID)
  expect(posts()[2].body.parts[0].text).toBe("never landed")
  console.info("PASS absent message: no automatic resend; explicit Send again reuses the same ID")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

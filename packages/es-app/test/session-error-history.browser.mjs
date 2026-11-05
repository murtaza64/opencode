import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.mail = () => ({ editspace: "fixture", lane: "", messages: [] })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const writes = []
page.on("request", (request) => {
  // The page's own timing beacon (POST /__es/perf, telemetry only) is not a session write.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && new URL(request.url()).pathname !== "/__es/perf") writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
})
preview.fixture.messages[1].info.error = {
  name: "APIError", data: { message: "Usage limit has been reached", statusCode: 429, isRetryable: false },
}

try {
  await page.goto(preview.url)
  const errors = page.locator(".session-page .transcript .conversation-error")
  await expect(errors).toHaveCount(1)
  await expect(errors.first().locator(".conversation-error-cause")).toHaveText("Usage limit has been reached")
  await expect(errors.first().locator(".conversation-error-detail")).toContainText("Usage limit has been reached")
  await expect(errors.first().locator("summary")).toContainText("Details")
  await expect(page.locator(".session-alerts")).not.toContainText("Usage limit has been reached")

  preview.fixture.messages.push(
    { info: { ...preview.fixture.messages[0].info, id: "msg_3", time: { created: 3 } }, parts: [] },
    { info: { ...preview.fixture.messages[1].info, id: "msg_4", parentID: "msg_3", time: { created: 4, completed: 5 },
      error: { name: "ProviderAuthError", data: { providerID: "fixture", message: "Token is expired" } } }, parts: [] },
  )
  await page.reload()
  await expect(errors).toHaveCount(2)
  await expect(errors.nth(0).locator(".conversation-error-cause")).toHaveText("Usage limit has been reached")
  await expect(errors.nth(1).locator(".conversation-error-cause")).toHaveText("Token is expired")
  await expect(page.locator(".session-alerts")).not.toContainText(/Usage limit has been reached|Token is expired/)

  preview.fixture.messages.push(
    { info: { ...preview.fixture.messages[0].info, id: "msg_5", time: { created: 6 } }, parts: [] },
    { info: { ...preview.fixture.messages[1].info, id: "msg_6", parentID: "msg_5", time: { created: 7 },
      error: { name: "MessageAbortedError", data: { message: "Interrupted" } } }, parts: [] },
  )
  await page.reload()
  await expect(errors).toHaveCount(2)
  await expect(page.locator('[data-find-message="msg_6"] .turn-summary[data-state="interrupted"]')).toHaveCount(1)
  await expect(page.locator(".session-alerts")).not.toContainText(/Usage limit has been reached|Token is expired/)

  preview.fixture.emit("session.error", { sessionID: "ses_a", error: { name: "UnknownError", data: { message: "Transient connection failure" } } })
  await expect(page.locator(".session-alerts")).toContainText("Transient connection failure")
  await expect(errors).toHaveCount(2)
  expect(writes).toEqual([])
  console.log("persistent provider errors in conversation: PASS")
} finally {
  await browser.close()
  await preview.close()
}

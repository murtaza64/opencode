// es-app#186: a routine send/steer/queue never inserts and removes a status row below the
// composer controls. The transcript and composer keep their bounds from send to settle; the
// in-flight state shows in the existing work-status slot.
// Run from packages/es-app: node test/composer-status-stable.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const box = async (selector) => {
  const value = await page.locator(selector).first().boundingBox()
  return value && [value.x, value.y, value.width, value.height].map(Math.round)
}
const editor = page.getByRole("textbox", { name: "Message", exact: true })
try {
  await page.goto(preview.url, { timeout: 90_000 })
  const status = page.locator(".session-work-status:visible")
  await expect(status).toHaveAttribute("data-state", "working")
  await page.evaluate(() => document.fonts.ready)
  const before = { transcript: await box(".session-main .transcript"), prompt: await box(".prompt-box"), status: await box(".session-work-status") }
  fixture.holdInput = true
  await editor.fill("steer while the daemon is slow")
  await page.getByRole("button", { name: "Steer", exact: true }).click()
  await expect(status).toHaveAttribute("data-state", "admitting")
  await expect(status).toContainText("Sending your message")
  await expect(page.locator(".input-admission")).toHaveCount(0)
  expect({ transcript: await box(".session-main .transcript"), prompt: await box(".prompt-box"), status: await box(".session-work-status") }).toEqual(before)
  fixture.holdInput = false
  fixture.inputReplies.splice(0).forEach((reply) => reply())
  await expect(status).not.toHaveAttribute("data-state", "admitting")
  // Once admitted, the input is real pending work and is listed (editable/cancellable) until it
  // is promoted; no transient send/admission row remains.
  await expect(page.locator(".normal-submission, .input-admission")).toHaveCount(0)
  await expect(page.locator(".composer-results")).toContainText("steer while the daemon is slow")
  console.info("PASS held steer: in-flight state only in the work-status slot (transcript, status and composer bounds unchanged); admitted input then listed as pending work")
  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

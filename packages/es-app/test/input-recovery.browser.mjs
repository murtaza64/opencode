import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.sessionModels.set("ses_a", { id: "test", providerID: "fixture", variant: "default" })
fixture.loseInput = true
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const posts = () => fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/input"))
const deletes = () => fixture.calls.filter((call) => call.method === "DELETE")
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  const queue = async () => {
    await page.getByRole("button", { name: "More send options", exact: true }).click()
    await page.getByRole("button", { name: "Queue", exact: true }).click()
  }
  await editor.fill("Unknown original request")
  await queue()
  // Lost POST, and the readback by request ID finds nothing: "Not sent" with exactly one action, Retry.
  const admission = page.locator(".input-admission")
  await expect(admission.locator(".outgoing-cue > span")).toHaveText("Not sent")
  await expect(admission.locator(".outgoing-action")).toHaveCount(1)
  await expect(admission.getByRole("button", { name: "Check and retry same input", exact: true })).toBeVisible()
  // The outgoing bubble holds the message, so the editor is free for a newer draft.
  await expect(editor).toHaveValue("")
  const original = posts()[0].body
  expect(posts()).toHaveLength(1)
  // Sending a newer message sets the unknown one aside (same request ID, kept locally) instead of blocking.
  await editor.fill("Newer request")
  await queue()
  await expect.poll(() => posts().length).toBe(2)
  expect(posts()[1].body.text).toBe("Newer request")
  const recovery = page.locator(`.input-recovery[data-recovery-id="${original.requestID}"]`)
  const cue = recovery.locator(".outgoing-cue")
  await expect(recovery).toContainText("Unknown original request")
  await expect(cue).toHaveAttribute("title", new RegExp(`Request ${original.requestID}`))
  await expect(page.locator(".composer-results")).toBeHidden()
  // Survives reload; the background check (GET only) settles it to "Not sent" with one Retry.
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(recovery).toContainText("Unknown original request")
  await expect(cue.locator("span").first()).toHaveText("Not sent")
  await expect(recovery.locator(".outgoing-action")).toHaveCount(1)
  expect(posts()).toHaveLength(2)
  expect(deletes()).toHaveLength(0)
  fixture.sessionModels.set("ses_a", { id: "test-mini", providerID: "fixture", variant: "default" })
  await page.getByRole("button", { name: "Check and retry same set-aside input", exact: true }).click()
  await expect(cue).toHaveAttribute("title", /Original model no longer matches/)
  expect(posts()).toHaveLength(2)
  fixture.sessionModels.set("ses_a", { id: "test", providerID: "fixture", variant: "default" })
  await page.getByRole("button", { name: "Check and retry same set-aside input", exact: true }).click()
  await expect.poll(() => posts().length).toBe(3)
  expect(posts()[2].body).toEqual(original)
  // Once reconciled to a pending receipt it shows as that queued input, still one bubble.
  await expect(page.locator(`[data-request-id="${original.requestID}"]`)).toHaveCount(1)
  await expect(page.locator(`[data-request-id="${original.requestID}"] .outgoing-cue`)).toContainText("Queued · after this task")
  expect(deletes()).toHaveLength(0)
  expect(fixture.unexpected).toEqual([])
  console.log("PASS unknown input: Not sent + one Retry, set aside by the next send, reload, GET-only check, explicit same-ID retry, no cancel")
} finally {
  await browser.close()
  await preview.close()
}

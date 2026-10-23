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
  await editor.fill("Unknown original request")
  await page.getByRole("button", { name: "More send options", exact: true }).click()
  await page.getByRole("button", { name: "Queue", exact: true }).click()
  await expect(page.locator(".input-admission")).toContainText("Not confirmed · queued")
  // The outgoing bubble holds the message, so the editor is free for a newer draft.
  await expect(editor).toHaveValue("")
  const original = posts()[0].body
  await editor.fill("Keep newer draft")
  await page.getByRole("button", { name: "Set aside unknown input", exact: true }).click()
  await expect(page.locator(".input-admission")).toHaveCount(0)
  await expect(editor).toHaveValue("Keep newer draft")
  await page.getByRole("button", { name: "More send options", exact: true }).click()
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeEnabled()
  await page.keyboard.press("Escape")
  // Set-aside inputs are outgoing bubbles; the request ID and any check error live in the cue title.
  const recovery = page.locator(`.input-recovery[data-recovery-id="${original.requestID}"]`)
  const cue = recovery.locator(".outgoing-cue")
  await expect(recovery).toContainText("Unknown original request")
  await expect(cue).toContainText("Set aside, not confirmed")
  await expect(cue).toHaveAttribute("title", new RegExp(`Request ${original.requestID}`))
  await expect(page.locator(".composer-results")).toBeHidden()
  await page.getByRole("button", { name: "Check set-aside input", exact: true }).click()
  await expect(cue).toHaveAttribute("title", /admission is still unknown/)
  expect(posts()).toHaveLength(1)
  expect(deletes()).toHaveLength(0)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator(".input-admission")).toHaveCount(0)
  await expect(editor).toHaveValue("Keep newer draft")
  await expect(recovery).toContainText("Unknown original request")
  expect(posts()).toHaveLength(1)
  fixture.loseInput = false
  fixture.sessionModels.set("ses_a", { id: "test-mini", providerID: "fixture", variant: "default" })
  await page.getByRole("button", { name: "Check and retry same set-aside input", exact: true }).click()
  await expect(cue).toHaveAttribute("title", /Original model no longer matches/)
  expect(posts()).toHaveLength(1)
  await expect(editor).toHaveValue("Keep newer draft")
  fixture.sessionModels.set("ses_a", { id: "test", providerID: "fixture", variant: "default" })
  await page.getByRole("button", { name: "Check and retry same set-aside input", exact: true }).click()
  await expect.poll(() => posts().length).toBe(2)
  expect(posts()[1].body).toEqual(original)
  // Once reconciled to a pending receipt it shows as that queued input, still one bubble.
  await expect(page.locator(`[data-request-id="${original.requestID}"]`)).toHaveCount(1)
  await expect(page.locator(`[data-request-id="${original.requestID}"] .outgoing-cue`)).toContainText(/Queued · after this task|Set aside · pending/)
  await expect(editor).toHaveValue("Keep newer draft")
  expect(deletes()).toHaveLength(0)
  expect(fixture.unexpected).toEqual([])
  console.log("PASS unknown input set-aside: newer draft, reload, GET-only check, explicit same-ID retry, no cancel")
} finally {
  await browser.close()
  await preview.close()
}

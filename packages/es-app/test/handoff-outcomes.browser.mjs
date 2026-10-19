import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.mail = () => ({ editspace: "fixture", messages: [] })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const href = (id) => `${preview.origin}/session/${id}?directory=${encodeURIComponent(directory)}`
const editor = (page) => page.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })
const edge = { lane: "work", predecessor: "ses_a", successor: "ses_b" }
try {
  const cancellation = await browser.newContext()
  const page = await cancellation.newPage()
  fixture.status = "idle"
  fixture.laneOwners = [{ lane: "work", owner: "ses_a" }]
  await page.goto(href("ses_b"))
  await editor(page).fill("Destination kept on cancel")
  await page.goto(href("ses_a"))
  await editor(page).fill("Source kept on cancel")
  await page.route("**/es/api/handoffs?*", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    fixture.handoffs = [edge]
    fixture.laneOwners = [{ lane: "work", owner: "ses_b" }]
    await route.fulfill({ json: edge })
  })
  let dialogs = 0
  page.on("dialog", async (dialog) => { dialogs++; await dialog.dismiss() })
  await page.getByRole("button", { name: "Hand off", exact: true }).click()
  await page.getByRole("textbox", { name: "Successor task" }).fill("Continue")
  await page.getByRole("textbox", { name: "Handoff notes" }).fill("Disposable notes")
  await page.getByRole("button", { name: "Create successor", exact: true }).click()
  await expect(page.locator(".handoff-recovery")).toContainText("drafts were kept")
  const tick = page.waitForResponse((response) => response.url().includes("/es/api/handoffs") && response.request().method() === "GET")
  fixture.emitDashboard("state")
  await tick
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(dialogs).toBe(1)
  await expect(page).toHaveURL(href("ses_a"))
  await expect(editor(page)).toHaveValue("Source kept on cancel")
  await cancellation.close()

  // A transient metadata failure can retry on the next dashboard observation.
  fixture.handoffs = []
  fixture.laneOwners = [{ lane: "work", owner: "ses_a" }]
  const transient = await browser.newContext()
  const retry = await transient.newPage()
  await retry.goto(href("ses_a"))
  await editor(retry).fill("Automatic source after network recovery")
  await retry.route("**/oc/session/ses_b?*", (route) => route.fulfill({ status: 503, json: { error: "temporary fixture failure" } }))
  fixture.handoffs = [edge]
  fixture.laneOwners = [{ lane: "work", owner: "ses_b" }]
  fixture.emitDashboard("state")
  await expect(retry.locator(".handoff-recovery")).toContainText("Could not open the successor")
  await retry.unroute("**/oc/session/ses_b?*")
  fixture.emitDashboard("state")
  await expect(retry).toHaveURL(href("ses_b"))
  await expect(editor(retry)).toHaveValue("Automatic source after network recovery")
  await transient.close()

  // A superseded wake may follow durable admission. A missing receipt is not
  // permission to move an identical input into another session.
  fixture.handoffs = []
  fixture.laneOwners = []
  fixture.status = "busy"
  fixture.superseded.set("ses_a", { successor: "ses_b" })
  const uncertain = await browser.newContext()
  const unknown = await uncertain.newPage()
  await unknown.goto(href("ses_a"))
  await editor(unknown).fill("Possibly admitted input")
  await unknown.locator(".prompt-box").getByRole("button", { name: "Queue", exact: true }).click()
  await expect(unknown.locator(".transcript .handoff-recovery")).toContainText("admission of this input is unknown")
  await expect(unknown.locator(".transcript .handoff-recovery").getByRole("link")).toHaveCount(0)
  await expect(unknown.locator(".input-admission")).toHaveCount(0)
  await expect(editor(unknown)).toHaveValue("Possibly admitted input")
  await unknown.locator(".handoff-recovery").getByRole("button", { name: "Check admission" }).click()
  await expect(unknown.locator(".handoff-recovery")).toContainText("may already have been accepted")
  await uncertain.close()
  console.log("handoff outcomes: explicit overwrite cancellation stays cancelled, transient auto-follow retries, superseded admission uncertainty stays transcript-local and cannot transfer: PASS")
} finally {
  await browser.close()
  await preview.close()
}

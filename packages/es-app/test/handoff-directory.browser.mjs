import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
fixture.mail = () => ({ editspace: "fixture", messages: [] })
const targetDirectory = `${directory}/.editspace/lanes/work/repos/owner/repo`
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.addInitScript(() => {
  localStorage.setItem("es-app-editspace", "other")
  localStorage.setItem("es-app-sidebar-pins", JSON.stringify([JSON.stringify(["/outside-alias", "ses_a"])]))
})
await page.route("**/es/api/handoffs?es=other", (route) => route.fulfill({ json: { handoffs: [] } }))
await page.route("**/es/api/state?es=other", async (route) => {
  const response = await route.fetch()
  const body = await response.json()
  await route.fulfill({ json: { ...body, editspace: "other", threads: body.threads.map((thread) => ({ ...thread, lanes: [] })) } })
})
const rewrite = (row) => row.id === "ses_b" ? { ...row, directory: targetDirectory } : row
await page.route("**/oc/experimental/session?*", async (route) => {
  const response = await route.fetch()
  await route.fulfill({ json: (await response.json()).map(rewrite) })
})
await page.route("**/oc/session/ses_b?*", async (route) => {
  const response = await route.fetch()
  await route.fulfill({ json: rewrite(await response.json()) })
})
try {
  await page.goto(preview.url)
  const editor = page.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Cross directory draft")
  fixture.handoffs = [{ lane: "work", predecessor: "ses_a", successor: "ses_b" }]
  fixture.laneOwners = [{ lane: "work", owner: "ses_b" }]
  fixture.superseded.set("ses_a", { successor: "ses_b" })
  fixture.emitDashboard("state")
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("es-app-sidebar-pins")))).toEqual([JSON.stringify([targetDirectory, "ses_b"])])
  await page.locator(".prompt-box").getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator(".handoff-recovery")).toContainText("Message not sent")
  const before = fixture.calls.filter((call) => call.method === "POST" || call.method === "PATCH").length
  // Nonessential pin persistence failure cannot undo a committed draft transfer.
  await page.evaluate(() => {
    localStorage.setItem("es-app-sidebar-pins", JSON.stringify([JSON.stringify(["/outside-alias", "ses_a"])]))
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === "es-app-sidebar-pins") throw new DOMException("fixture pin quota", "QuotaExceededError")
      return original.call(this, key, value)
    }
  })
  await page.locator(".handoff-recovery").getByRole("link").click()
  await expect(page).toHaveURL(`${preview.origin}/session/ses_b?directory=${encodeURIComponent(targetDirectory)}`)
  await expect(editor).toHaveValue("Cross directory draft")
  await expect(page.getByLabel("Previous session").getByRole("link")).toHaveAttribute("href", `/session/ses_a?directory=${encodeURIComponent(directory)}`)
  expect(fixture.calls.filter((call) => call.method === "POST" || call.method === "PATCH")).toHaveLength(before)
  expect(errors).toEqual([])
  console.log("cross-directory handoff while another editspace is selected: alias pin canonicalization, verified draft recovery, previous pointer, pin quota without false draft failure: PASS")
} finally {
  await browser.close()
  await preview.close()
}

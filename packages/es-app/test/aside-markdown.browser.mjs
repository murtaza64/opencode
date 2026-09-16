import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await page.route("**/oc/session/ses_a/aside?**", (route) => route.fulfill({ json: {
  requestID: route.request().postDataJSON().requestID,
  text: "## Snapshot\n\n**Independent answer** with `inline code`.\n\n- First item\n- Second item\n\n[Reference](https://example.com/guide)",
  snapshot: { capturedAt: Date.now(), excludedMessageCount: 0, activity: { status: "busy", tools: [] } },
} }))
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Give a formatted answer")
  await page.getByRole("button", { name: "Aside", exact: true }).click()
  const answer = page.locator(".aside-answer")
  await expect(answer.getByRole("heading", { name: "Snapshot" })).toBeVisible()
  await expect(answer.locator("strong")).toHaveText("Independent answer")
  await expect(answer.locator("code")).toHaveText("inline code")
  await expect(answer.locator("li")).toHaveCount(2)
  await expect(answer.getByRole("link", { name: "Reference" })).toHaveAttribute("href", "https://example.com/guide")
  await expect(page.locator(".transcript")).not.toContainText("Independent answer")
  expect(errors).toEqual([])
  console.log("PASS Aside Markdown: heading, emphasis, code, list, link; separate from transcript")
} finally {
  await preview.close()
  await browser.close()
}

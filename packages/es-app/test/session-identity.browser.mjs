import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
let metadata = { ...session("ses_a"), agent: undefined, model: undefined }
preview.fixture.messages[0].info.agent = "yolo"
preview.fixture.messages[0].info.model = { providerID: "openai", modelID: "gpt-6-astra" }
preview.fixture.messages[1].info.agent = undefined
preview.fixture.messages[1].info.mode = "yolo"
preview.fixture.messages[1].info.providerID = "openai"
preview.fixture.messages[1].info.modelID = "gpt-6-astra"
const writes = []
page.on("request", (request) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method())
})
await page.route((url) => url.pathname === "/oc/session/ses_a", (route) => route.fulfill({ json: metadata }))
try {
  await page.goto(preview.url)
  const panel = page.locator(".session-info")
  await expect(panel.locator('[data-fact="agent"]')).toContainText("yolo")
  await expect(panel.locator('[data-fact="provider"]')).toContainText("openai")
  await expect(panel.locator('[data-fact="provider"]')).toHaveAttribute("title", "latest observed provider")
  await expect(panel.locator('[data-fact="model"]')).toContainText("gpt-6-astra")

  metadata = { ...session("ses_a"), agent: "plan", model: { id: "preferred", providerID: "other" } }
  await page.reload()
  await expect(panel.locator('[data-fact="agent"]')).toContainText("plan")
  await expect(panel.locator('[data-fact="provider"]')).toContainText("other")
  await expect(panel.locator('[data-fact="provider"]')).toHaveAttribute("title", "session provider")
  await expect(panel.locator('[data-fact="model"]')).toContainText("preferred")

  metadata = { ...session("ses_a"), agent: undefined, model: undefined }
  preview.fixture.messages = []
  await page.reload()
  await expect(panel.locator('[data-fact="agent"]')).toContainText("unknown")
  await expect(panel.locator('[data-fact="provider"]')).toContainText("unknown")
  await expect(panel.locator('[data-fact="model"]')).toHaveCount(0)
  expect(writes).toEqual([])
  console.log("session identity panel: PASS")
} finally {
  await browser.close()
  await preview.close()
}

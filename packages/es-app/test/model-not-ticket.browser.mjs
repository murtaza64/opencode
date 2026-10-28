// The composer's model button never becomes a Jira ref (a model named "GPT-6.1 Sol" contains GPT-6), while a real
// key in transcript prose still gets its hover card. No tracker is contacted: the ticket lookup is fulfilled locally.
// Run from packages/es-app: node test/model-not-ticket.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.messages[1].parts[0].text = "Tracked in PLATFORM-138."
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await context.route("**/config/providers*", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.providers[0].models.test.name = "GPT-6.1 Sol"
    await route.fulfill({ response, json: body })
  })
  await context.route("**/es/api/issue?*", (route) => route.fulfill({ json: { ref: "PLATFORM-138", title: "Fixture ticket", status: "open", url: "https://example.invalid/PLATFORM-138" } }))
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const model = page.getByRole("button", { name: /^Change model/ })
  await expect(model.locator(".direct-model-name")).toHaveText("GPT-6.1 Sol")
  // Prose keeps its ref, which also proves the wrapper has run over the page.
  const prose = page.locator('.ticket-ref[data-ticket="PLATFORM-138"]')
  await expect(prose).toHaveCount(1)
  await expect(model.locator(".ticket-ref")).toHaveCount(0)
  await model.hover()
  await page.waitForTimeout(600)
  await expect(page.locator(".ticket-tip")).toHaveCount(0)
  await prose.hover()
  await expect(page.locator(".ticket-tip")).toBeVisible()
  expect(errors).toEqual([])
  console.log("PASS model name is not a ticket ref: GPT-6.1 Sol button has no ref or hover card; prose PLATFORM-138 keeps its card")
} finally {
  await preview.close()
  await browser.close()
}

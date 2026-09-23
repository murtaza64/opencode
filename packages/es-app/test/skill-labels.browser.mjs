import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const assistant = preview.fixture.messages[1]
assistant.parts = ["grill-with-docs", "grilling", "domain-modeling", "MixedCase-Skill", ""].map((name, index) => ({
  id: `skill-${index}`, messageID: assistant.info.id, sessionID: "ses_a", type: "tool", callID: `call-${index}`, tool: "skill",
  state: { status: index === 1 ? "running" : index === 2 ? "pending" : "completed", input: name ? { name } : {}, raw: "{}", title: name, output: "Loaded", metadata: {}, time: { start: 1, end: 2 } },
}))
assistant.parts.push({ id: "shell", messageID: assistant.info.id, sessionID: "ses_a", type: "tool", callID: "shell", tool: "bash", state: { status: "completed", input: { command: "true" }, title: "", output: "", metadata: {}, time: { start: 1, end: 2 } } })
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
await page.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  const labels = page.locator('.transcript [data-tool="skill"] [data-slot="basic-tool-tool-title"]')
  await expect(labels.locator('[data-slot="text-shimmer-char-base"]')).toHaveText(["Skill", "Skill", "Skill", "Skill", "Skill"])
  await expect(page.locator('.transcript [data-tool="skill"] [data-slot="basic-tool-tool-subtitle"]')).toHaveText(["grill-with-docs", "grilling", "domain-modeling", "MixedCase-Skill"])
  expect(await labels.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).textTransform))).toEqual(["none", "none", "none", "none", "none"])
  await expect(page.locator('.transcript [data-slot="text-shimmer-char-base"]').filter({ hasText: /^Shell$/ })).toBeVisible()
  expect(errors).toEqual([])
  expect(preview.fixture.calls.filter((call) => call.method !== "GET")).toEqual([])
  console.log("PASS Skill prefix and original casing across completed/running/pending states; mixed-case/fallback and Shell preserved")
} finally { await preview.close(); await browser.close() }

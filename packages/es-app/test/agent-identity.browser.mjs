// Agent identity display slice (spec r2): project/lane primary, registered alias before it, session title as the task.
// The Desk pointer is Porter; the opencode/front-desk implementation lane is not Porter. Display only.
// Run from packages/es-app: node test/agent-identity.browser.mjs [--shots DIR]
import { createRequire } from "node:module"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
preview.fixture.laneOwners = [{ lane: JSON.stringify(["fixture", "ux-impl"]), owner: "ses_a" }]
preview.fixture.personas = [{ name: "Loupe", owner_lane: "fixture/ux-impl", avatar_url: "https://example.com/loupe.png" }]
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => localStorage.setItem("es-app:sidebar-density", "expanded"))
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  // Chat header: alias · project/lane, the session title as the task subtitle.
  await expect(page.locator(".session-identity-name")).toContainText("Loupe · fixture/ux-impl", { timeout: 120_000 })
  await expect(page.locator(".session-identity-task")).toContainText("Composer fixture")
  // Sidebar: the same identity is primary; the task is the second line.
  const row = page.locator('.sidebar .session-entry a[href*="/session/ses_a"]')
  await expect(row.locator(".nav-title")).toHaveText("Loupe · fixture/ux-impl")
  await expect(row.locator("xpath=..").locator(".row-secondary")).toContainText("Composer fixture")
  if (shots) await page.screenshot({ path: path.join(shots, "agent-identity-1440.png"), clip: { x: 0, y: 0, width: 1440, height: 360 } })
  // Porter is the Desk pointer; its chat shows Porter · Work Front Desk with the task beneath.
  await page.evaluate((value) => localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)), { session: "ses_b", directory })
  await page.goto(`${preview.origin}/session/ses_b?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(".session-identity-name")).toContainText("Porter · Work Front Desk", { timeout: 60_000 })
  await expect(page.locator(".session-identity-task")).toContainText("Other session")
  if (shots) await page.screenshot({ path: path.join(shots, "agent-identity-porter.png"), clip: { x: 0, y: 0, width: 1440, height: 300 } })
  if (errors.length) throw new Error(errors.join("; "))
  console.log("PASS agent identity: alias · project/lane in chat header and sidebar, session title as task, Desk pointer is Porter")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}

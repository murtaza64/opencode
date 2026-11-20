// "Could not load the chat" is not sticky: when this computer's Core answers the desk read with 503 (as a Core whose
// instance for the desk's directory failed to boot does), the next background poll reads it again and the chat loads
// without pressing Check again. No home is configured (pointer 404), like a laptop whose Mini is off and was never
// read. Disposable fixture only.
// Run from packages/es-app: node test/desk-unavailable-recovers.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
let failing = true
let refused = 0
await page.route((url) => url.pathname === "/oc/session/ses_a", (route) => {
  if (!failing) return route.continue()
  refused += 1
  return route.fulfill({ status: 503, body: "" })
})
const chat = page.locator(".desk-companion")
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(chat.getByText("Could not load the chat.")).toBeVisible({ timeout: 90_000 })
  expect(refused).toBeGreaterThan(0)
  console.log("503: Could not load the chat")
  failing = false
  // One poll (15 s) re-reads it; no click.
  await expect(chat.locator(".desk-chat textarea")).toBeVisible({ timeout: 30_000 })
  await expect(chat.getByText("Could not load the chat.")).toHaveCount(0)
  console.log("Core answers again: chat loads by itself")
  console.log("PASS desk-unavailable-recovers")
} catch (error) {
  console.error("FAIL desk-unavailable-recovers", error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close?.()
  process.exit(process.exitCode ?? 0)
}

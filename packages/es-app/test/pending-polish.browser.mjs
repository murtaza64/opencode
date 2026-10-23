import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.receipts = Array.from({ length: 25 }, (_, i) => ({ requestID: `pending-${i}`, sessionID: "ses_a", delivery: "queue", text: `Queued item ${i}`, agent: "build", admittedSeq: i + 1, timeCreated: 1, state: "pending" }))
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const page = await browser.newPage()
await page.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  // 25 pending inputs are outgoing bubbles in the transcript tail, not a panel above the composer.
  await expect(page.locator(".input-receipts li")).toHaveCount(25)
  await expect(page.locator(".composer-results")).toBeHidden()
  const transcript = await page.locator(".session-main .transcript").boundingBox()
  const composer = await page.locator(".prompt-box").boundingBox()
  expect(composer.y).toBeGreaterThanOrEqual(transcript.y + transcript.height - 1)
  await page.locator(".session-main .transcript").evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(page.locator('.input-receipts li[data-request-id="pending-24"]')).toBeInViewport()
  const pulse = page.locator(".session-work-spinner").first()
  // Stepped by the shared pulse clock: no compositor animation, both phases visible.
  await expect(pulse).toHaveCSS("animation-name", "none")
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length)).toBe(0)
  await expect(pulse).toHaveAttribute("data-on", "true")
  await expect(pulse).toHaveCSS("opacity", "1")
  await expect(pulse).not.toHaveAttribute("data-on")
  await expect(pulse).toHaveCSS("opacity", "0.45")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(pulse).toHaveCSS("opacity", "1")
  console.log("PASS 25 pending inputs as transcript bubbles with no composer panel, stepped nonzero opacity pulse without animations, reduced motion")
} finally { await preview.close(); await browser.close() }

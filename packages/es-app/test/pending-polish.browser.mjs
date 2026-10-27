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
  // One busy idiom: the work line's halo is the only running animation, CSS-only on a pseudo-element.
  const dot = page.locator(".session-work-status .busy-dot[data-animate]").first()
  await expect(dot).toBeVisible()
  const animations = () => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running")
    .map((animation) => ({ name: animation.animationName, pseudo: animation.effect?.pseudoElement ?? null })))
  // One-shot entrance fades finish; the halo keeps running.
  await expect.poll(animations).toEqual([{ name: "busy-halo", pseudo: "::after" }])
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect.poll(animations).toEqual([])
  expect(await dot.evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("0.5")
  console.log("PASS 25 pending inputs as transcript bubbles with no composer panel, one CSS halo animation (work line only), static under reduced motion")
} finally { await preview.close(); await browser.close() }

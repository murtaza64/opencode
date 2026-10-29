// Preview motion scenario (living-chat #263): `?replay=motion` (or the "Replay motion" button) plays, without a reload,
// one text part streamed three times in 4/40/400-character deltas at the same rate, a bash call running ~4 s then
// done, an edit with file and +/- counts, an incoming mail with a scheduled wake, a new user message, then idle.
// Run from packages/es-app: node test/preview-motion.browser.mjs
import { createRequire } from "node:module"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startToolRunsPreview(0, { replay: true })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.context().route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${preview.url}&replay=motion&filament=1`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await page.evaluate(() => { window.__noReload = true })
  const started = Date.now()
  await expect(page.getByRole("button", { name: "Replay motion", exact: true })).toBeVisible()
  // 1. The reply streams: the text grows across three passes of the same words.
  // Each pass is its own paragraph; all three end on the same closing words once streamed.
  const passes = page.locator(".transcript").getByText(/^Reading the composer/)
  await expect(passes.first()).toBeVisible({ timeout: 15_000 })
  await expect(passes).toHaveCount(3, { timeout: 20_000 })
  await expect(passes.last()).toContainText("three passes.", { timeout: 10_000 })
  // 2. A bash call runs, then completes.
  const shell = page.locator('.tool-chip[data-timeline-part-id$="_bash"]')
  await expect(shell.locator(".tool-chip-state")).toHaveText(/^running · bun test src\/composer/, { timeout: 10_000 })
  await expect(shell.locator(".tool-chip-state")).toHaveText("bun test src/composer", { timeout: 8_000 })
  // 3. The edit shows pencil, file and counts.
  await expect(page.locator('.tool-chip[data-timeline-part-id$="_edit"] .tool-chip-state')).toHaveText("direct-composer.tsx +6 −2", { timeout: 5_000 })
  // 4. Incoming mail with its record (wake caused).
  const mail = page.locator(".mail-activity[data-mail-message-id^='msg_m']")
  await expect(mail).toHaveCount(1, { timeout: 10_000 })
  await expect(mail.locator(".mail-activity-summary")).toHaveAttribute("data-wake", "caused", { timeout: 10_000 })
  // 5. A new user message, then 6. idle.
  await expect(page.locator(".transcript").getByText("Thanks, that is all for now.")).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(".topbar")).toContainText("idle", { timeout: 10_000 })
  const seconds = (Date.now() - started) / 1000
  expect(seconds).toBeLessThan(30)
  expect(await page.evaluate(() => window.__noReload)).toBe(true)
  expect(errors).toEqual([])
  expect(preview.fixture.unexpected).toEqual([])
  console.log(`PASS preview motion: three-pass stream (4/40/400 deltas, same rate), bash running->done, edit +6 −2, scheduled-wake mail with record, new prompt, idle; ${seconds.toFixed(1)} s, no reload`)
} finally {
  await preview.close()
  await browser.close()
}

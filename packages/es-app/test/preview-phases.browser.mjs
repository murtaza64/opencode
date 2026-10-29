// Preview phase replay (living-chat CHAT10): `?replay=phases` walks the ten assistant head states through the page's
// own signals, in order, without a reload; GET /__preview/phase names the current step. This test checks each step's
// signal is really present in the page (not how Filament draws it).
// Run from packages/es-app: node test/preview-phases.browser.mjs
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
  await page.goto(`${preview.url}&replay=phases`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await page.evaluate(() => { window.__noReload = true })
  const phase = async () => (await (await fetch(`${preview.origin}/__preview/phase`)).json()).phase
  const at = (name) => expect.poll(phase, { timeout: 30_000, intervals: [100] }).toBe(name)
  const work = page.locator(".session-work-status")
  const seen = []

  // 1. working: busy, the new assistant message has no parts yet.
  await at("working")
  await expect(work).toHaveAttribute("data-state", "working")
  seen.push("working")
  // 2. thinking: an open reasoning part for the reply reaches the page (its text is not asserted).
  await at("thinking")
  await expect(page.locator('[data-timeline-part-id$="_r"]').first()).toBeAttached({ timeout: 5_000 })
  seen.push("thinking")
  // 3. writing: the answer text grows.
  await at("writing")
  await expect(page.getByText(/^Writing the answer one clause at a time/).last()).toBeVisible()
  seen.push("writing")
  // 4. tool: bash running, then done.
  await at("tool")
  await expect(page.locator('.tool-chip[data-timeline-part-id$="_bash"] .tool-chip-state')).toHaveText(/^running/)
  seen.push("tool")
  // 5. delegated: a task tool is running.
  await at("delegated")
  await expect(page.locator('[data-timeline-part-id$="_task"]').first()).toBeVisible()
  seen.push("delegated")
  // 6. blocked: the permission request is shown.
  await at("blocked")
  await expect(page.getByText("rm -rf build").first()).toBeVisible({ timeout: 10_000 })
  seen.push("blocked")
  // 7. retry: the retry line names the attempt and the provider message.
  await at("retry")
  await expect(page.getByText("Retry 1: Fixture provider overloaded")).toBeVisible()
  seen.push("retry")
  // 8. offline: the event stream is down; the work status reports it once the debounce passes.
  await at("offline")
  await expect(work).toHaveAttribute("title", /.+/, { timeout: 5_000 })
  seen.push("offline")
  // 9. complete, 10. idle.
  await at("complete")
  await expect(work).toHaveAttribute("data-state", "idle", { timeout: 10_000 })
  seen.push("complete")
  await at("idle")
  seen.push("idle")
  await at("done")
  expect(seen).toEqual(["working", "thinking", "writing", "tool", "delegated", "blocked", "retry", "offline", "complete", "idle"])
  expect(await page.evaluate(() => window.__noReload)).toBe(true)
  expect(errors).toEqual([])
  console.log("PASS preview phases: working, thinking, writing, tool, delegated, blocked, retry, offline, complete, idle in order from page signals; no reload")
} finally {
  await preview.close()
  await browser.close()
}

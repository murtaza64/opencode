// The slim bar under a chat's top bar (desktop-chat-surface-discovery): the latest Surface this chat's agent
// published. Open keeps the bar; × dismisses that revision for this chat/device; a newer revision returns it
// with "updated"; the header menu and +N list the same author's Surfaces. No seen/read side effect.
// Run from packages/es-app: node test/surface-discovery.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
const now = Date.now()
const surface = (id, title, revision, updated = now, extra = {}) => ({ id, title, summary: null, kind: "path", owner: "loupe", lane: "fixture-impl",
  editspace: "fixture", updated_at: updated, revision, health: { state: "ok" }, purpose: "board", author_session: "ses_a", ...extra })
preview.fixture.surfaces = [surface("deck", "DevXAI Seattle deck", 1), surface("eks", "EKS migration dashboard", 3, now - 60_000)]
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  if (localStorage.getItem("surface-discovery-init")) return
  localStorage.setItem("surface-discovery-init", "1")
  for (const key of Object.keys(localStorage)) if (key.startsWith("es-app:surface-dismissed")) localStorage.removeItem(key)
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
const writes = []
page.on("pageerror", (error) => errors.push(error.message))
page.on("request", (request) => { if (request.method() !== "GET" && /deliverables\/seen/.test(request.url())) writes.push(request.url()) })
const bar = page.getByRole("region", { name: "Latest Surface" })
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(bar).toBeVisible({ timeout: 120_000 })
  await expect(bar).toContainText("DevXAI Seattle deck")
  await expect(bar).toContainText("r1")
  await expect(bar.getByRole("link", { name: "Open DevXAI Seattle deck · r1" })).toHaveAttribute("href", "/?item=surface%3Adeck")
  await expect(bar.getByRole("button", { name: "Dismiss DevXAI Seattle deck · r1" })).toBeVisible()
  // Arrival is quiet: no focus moves into the bar.
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".surface-discovery") ?? null), null)
  await expect(bar.locator(".surface-discovery-all summary")).toHaveText("+1")
  // More lists the author's other Surface.
  await bar.locator(".surface-discovery-all summary").click()
  await expect(bar.getByRole("link", { name: "EKS migration dashboard · r3" })).toBeVisible()
  if (shots) await page.screenshot({ path: path.join(shots, "surface-discovery-1440.png"), clip: { x: 0, y: 0, width: 1440, height: 420 } })
  // Open leaves the chat; returning keeps the bar (nothing dismissed).
  await bar.getByRole("link", { name: "Open DevXAI Seattle deck · r1" }).click()
  await expect(page).toHaveURL(/\/\?item=surface%3Adeck$/)
  await page.goBack({ waitUntil: "domcontentloaded" })
  await expect(bar).toBeVisible({ timeout: 60_000 })
  // × hides this revision for this chat; the header menu still lists it.
  await bar.getByRole("button", { name: "Dismiss DevXAI Seattle deck · r1" }).click()
  await expect(bar).toHaveCount(0)
  await page.locator(".session-header-tools").getByRole("button", { name: "Surfaces" }).click()
  await expect(page.getByRole("menuitem", { name: "DevXAI Seattle deck · r1" })).toBeVisible()
  await page.keyboard.press("Escape")
  // A new revision brings it back, marked updated.
  preview.fixture.surfaces = [surface("deck", "DevXAI Seattle deck", 2, now + 1000), surface("eks", "EKS migration dashboard", 3, now - 60_000)]
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(bar).toBeVisible({ timeout: 60_000 })
  await expect(bar).toContainText("r2")
  await expect(bar.locator(".surface-discovery-updated")).toHaveText("updated")
  await expect(page.locator(".session-header-tools").getByRole("button", { name: "Surfaces" })).toBeVisible()
  assert.deepEqual(writes, [], `discovery wrote no seen state: ${JSON.stringify(writes)}`)
  assert.deepEqual(errors.filter((error) => !/sandboxed.*localStorage|localStorage.*sandboxed/.test(error)), [])
  // 390: the row stays one line and its controls are reachable.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(bar).toBeVisible()
  const fit = await bar.evaluate((element) => ({ width: element.scrollWidth, box: element.clientWidth }))
  assert(fit.width <= fit.box + 1, `bar fits 390: ${JSON.stringify(fit)}`)
  if (shots) await page.screenshot({ path: path.join(shots, "surface-discovery-390.png"), clip: { x: 0, y: 0, width: 390, height: 300 } })
  // An older dashboard with no author_session is unknown: no bar, and no lane/link fallback.
  {
    const { author_session: _omitted, ...unauthored } = surface("unknown", "Unknown author", 1)
    preview.fixture.surfaces = [unauthored]
    const old = await context.newPage()
    await old.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
    await expect(old.locator(".session-page")).toBeVisible({ timeout: 120_000 })
    await old.waitForTimeout(1500)
    await expect(old.getByRole("region", { name: "Latest Surface" })).toHaveCount(0)
    await old.close()
  }
  // A Surface arriving while the chat is open does not move the transcript's scroll position.
  {
    const late = await context.newPage()
    late.setDefaultTimeout(60_000)
    preview.fixture.surfaces = []
    await late.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
    const transcript = late.locator(".transcript")
    await expect(transcript).toBeVisible({ timeout: 120_000 })
    const before = await transcript.evaluate((element) => element.scrollTop)
    preview.fixture.surfaces = [surface("late", "Late board", 1, Date.now())]
    await expect(late.getByRole("region", { name: "Latest Surface" })).toBeVisible({ timeout: 25_000 })
    assert.equal(await transcript.evaluate((element) => element.scrollTop), before, "a late bar does not move the transcript")
    await late.close()
  }
  console.log("PASS surface discovery: latest published Surface, Open keeps it, dismiss per revision, updated on a new revision, +N list, header menu, no focus/scroll steal, no seen write, 390")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}

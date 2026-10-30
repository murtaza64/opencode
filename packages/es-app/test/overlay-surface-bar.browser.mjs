// A narrow window (overlay chat, 901-1199px): opening the Front desk chat over an open Surface leaves the Surface's
// bar actions (open in new tab, Close) visible and clickable. Run from packages/es-app.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const label = process.env.LABEL ?? "after"
const now = Date.now()
await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [
  { id: "ops", title: "Ops report", summary: null, kind: "path", owner: "fixture", lane: null, editspace: "fixture", updated_at: now, revision: 1, health: { state: "ok" } }] } }))
await page.route("**/__es/surface/ops", (route) => route.fulfill({ json: { src: "/__fixture/ops.html", expires_at: now + 600_000 } }))
await page.route("**/__fixture/ops.html", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Ops report body</h1>" }))
const reachable = (locator) => locator.evaluate((el) => {
  const box = el.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return !!hit && (hit === el || el.contains(hit))
})
try {
  await page.goto(`${preview.origin}/?surface=ops`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const bar = page.locator(".desk-surface .surface-bar")
  const actions = bar.locator(".surface-bar-actions > :is(a, button)")
  await expect(actions.last()).toBeVisible({ timeout: 120_000 })
  if (!(await page.locator(".desk-companion.overlay:not(.closed)").count())) await page.locator('[data-nav="front-desk"]').click()
  await expect(page.locator(".desk-companion.overlay:not(.closed)")).toHaveCount(1)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `/tmp/overlay-surface-bar-${label}.png` })
  const check = async (when) => {
    const count = await actions.count()
    for (let i = 0; i < count; i++) if (!(await reachable(actions.nth(i)))) throw new Error(`${label} ${when}: Surface bar action ${i + 1}/${count} covered by the chat`)
  }
  await check("ltr")
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.waitForTimeout(200)
  await check("rtl")
  await page.screenshot({ path: `/tmp/overlay-surface-bar-${label}-rtl.png` })
  expect(errors).toEqual([])
  console.log(`overlay-surface-bar (${label}): PASS`)
} finally {
  await browser.close()
  await preview.close()
}

// Transcript scrollbar clearance (dotfiles#240): row controls at the transcript's inline end (tool-run
// disclosures, row actions) keep at least 12px from the scroller's edge, where an overlay scrollbar draws,
// so they stay visible and clickable; the transcript stays the one vertical scroller. The routine
// "status · age unknown" line is gone. LTR, RTL, 125% zoom and narrow.
// Disposable fixture. Run from packages/es-app: node test/transcript-clearance.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startToolRunsPreview(0, { filler: 5 })
preview.fixture.status = "busy"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const CLEAR = 12

let failed = false
const check = async (name, { width, height, rtl = false }) => {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  try {
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
    await expect(page.locator(".session-page .transcript .tool-run").first()).toBeVisible({ timeout: 120_000 })
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await page.waitForTimeout(200)
    const box = await page.evaluate(() => {
      const scroller = document.querySelector(".session-page .transcript")
      const edge = scroller.getBoundingClientRect()
      const rtl = getComputedStyle(scroller).direction === "rtl"
      // Distance from the scroller's inline-end edge to each visible control's inline-end side.
      const gaps = [...scroller.querySelectorAll(".tool-run-summary, .tool-run-span, .outgoing-action, [data-slot=basic-tool-tool-trigger]")]
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => { const r = el.getBoundingClientRect(); return Math.round(rtl ? r.left - edge.left : edge.right - r.right) })
      const scrollers = [...document.querySelectorAll(".session-page .session-main *")].filter(el => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 200)
      return { gaps, min: Math.min(...gaps), scrollers: scrollers.map(el => el.className), status: document.querySelector(".session-work-status")?.textContent ?? "" }
    })
    if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) })
    console.log(`${name} ${JSON.stringify({ min: box.min, n: box.gaps.length, status: box.status })}`)
    assert(box.gaps.length > 0, `${name}: controls found`)
    assert(box.min >= CLEAR, `${name}: controls keep ${CLEAR}px from the scrollbar edge (min ${box.min})`)
    assert(box.scrollers.length <= 1, `${name}: one vertical scroller, got ${JSON.stringify(box.scrollers)}`)
    assert(!/age unknown/.test(box.status), `${name}: no routine 'age unknown' copy (${box.status})`)
    // The rightmost disclosure takes a click.
    await page.locator(".session-page .transcript .tool-run-summary").first().click()
    await expect(page.locator(".session-page .transcript .tool-run").first()).toHaveAttribute("data-open", "true")
    console.log(`PASS ${name}`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${error.message}`)
  } finally {
    await context.close()
  }
}

try {
  await check("ltr-1440", { width: 1440, height: 900 })
  await check("rtl-1440", { width: 1440, height: 900, rtl: true })
  await check("zoom125-1152", { width: 1152, height: 720 })
  await check("narrow-600", { width: 600, height: 900 })
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("transcript-clearance: PASS")

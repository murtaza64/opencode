// Laptop2659: in the Mac app's title bar the session title starts at the chat's text edge, not after a fixed project
// column. It follows the sidebar when it is resized or collapsed (never under the traffic lights), and right to left
// keeps its own layout. The Electron Mac user agent turns on the real native header. Run from packages/es-app:
// node test/native-header-title.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const label = process.env.LABEL ?? "after"
const preview = await startPanelPreview()
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) es-desktop/1.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36"
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
let failed = false
// Where the title's text starts, and where the chat's text column starts (the session column inside its gutter).
const edges = page => page.evaluate(() => {
  const title = document.querySelector(".native-header .session-title")
  const main = document.querySelector(".session-page .session-main")
  const pad = parseFloat(getComputedStyle(main).paddingInlineStart)
  return { title: title.getBoundingClientRect().left, text: main.getBoundingClientRect().left + pad, project: document.querySelector(".native-header-project").getBoundingClientRect().right }
})
try {
  for (const [name, width, storage, rtl, strip] of [["wide", 1440, {}, false], ["resized", 1440, { "es-app-left-width": "340" }, false], ["collapsed", 1440, { "es-app-left-open": "0" }, false], ["narrow", 900, {}, false], ["host tabs", 1440, { "es-app-left-width": "340" }, false, 296], ["host tabs wider than the sidebar", 1440, {}, false, 296], ["rtl", 1440, {}, true]]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, userAgent })
    await context.addInitScript(values => { if (window === window.top) for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, storage)
    await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(60_000)
    await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
    await expect(page.locator(".native-header .session-title")).toContainText("Composer fixture", { timeout: 120_000 })
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
    // The desktop's native host tabs move the header's start (es-desktop tabs.ts inserts this rule).
    if (strip) await page.addStyleTag({ content: `:root{--host-tabs-end:${strip}px}.native-header-safe{left:max(84px,${strip}px)!important}` })
    await page.waitForTimeout(500)
    const at = await edges(page)
    if (shots) await page.screenshot({ path: path.join(shots, `${label}-${name}.png`), clip: { x: 0, y: 0, width, height: 160 } })
    if (name === "collapsed") assert(at.title >= 84, `${name}: title under the traffic lights (${at.title})`)
    // Under host tabs wider than the sidebar the title follows the toggle directly: no reserved column.
    else if (name === "host tabs wider than the sidebar") assert(at.title < at.text + 120 && at.project - at.title < 0 && at.title - at.project <= 13, `${name}: title ${at.title} after column end ${at.project}`)
    else if (!rtl) assert(Math.abs(at.title - at.text) <= 2, `${name}: title starts at ${at.title}, chat text at ${at.text}`)
    // Nothing in the bar overflows the window.
    assert(await page.evaluate(() => document.querySelector(".native-header").scrollWidth <= innerWidth + 1), `${name}: header overflows`)
    console.log(`${name}: title ${Math.round(at.title)} · chat text ${Math.round(at.text)} · project column ends ${Math.round(at.project)}`)
    await context.close()
  }
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("PASS native-header-title")

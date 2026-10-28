// Front desk companion (dotfiles#240): docked beside a session it resizes live from its inline-start edge
// (pointer and arrow keys, mirrored in RTL), within bounds, and remembers its width; while it is open the
// session info panel steps aside, and closing it brings the panel back at its own width. The composer
// draft, focus and transcript scroll survive. Disposable fixture.
// Run from packages/es-app: node test/companion-resize.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })

const open = async ({ dir = "ltr", stored }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await context.addInitScript(({ value, stored }) => { try {
    localStorage.setItem("es-app:front-desk:1", JSON.stringify(value))
    localStorage.setItem("es-app-right-open", "1"); localStorage.setItem("es-app-right-width", "300")
    localStorage.setItem("es-app:companion:session", "0")
    if (stored) localStorage.setItem("es-app-companion-width", String(stored)); else localStorage.removeItem("es-app-companion-width")
  } catch {} }, { value: { session: "ses_b", directory }, stored })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.locator(".session-main .prompt-box textarea, .session-page > .session-main textarea").first()).toBeVisible({ timeout: 120_000 })
  if (dir === "rtl") await page.evaluate(() => { document.documentElement.dir = "rtl" })
  return { page, errors, context }
}
const width = (page, selector) => page.locator(selector).evaluate(el => Math.round(el.getBoundingClientRect().width))
const companion = ".desk-companion"
const info = ".content .session-page > .session-info"

let failed = false
const check = async (name, options, body) => {
  const view = await open(options)
  try { await body(view.page); assert.deepEqual(view.errors, []); console.log(`PASS ${name}`) }
  catch (error) { failed = true; console.error(`FAIL ${name}: ${error.message}`) }
  finally { await view.context.close() }
}

try {
  await check("panel exclusion, draft and scroll kept", {}, async page => {
    const editor = page.locator(".content .session-main textarea").first()
    await editor.fill("draft kept while the chat opens")
    const scroller = page.locator(".content .session-page .transcript").first()
    await scroller.evaluate(el => { el.scrollTop = Math.max(0, el.scrollHeight / 2) })
    const scrollBefore = await scroller.evaluate(el => Math.round(el.scrollTop))
    assert.equal(await width(page, info), 300, "info panel at its own width before")
    if (shots) await page.screenshot({ path: path.join(shots, "before-open.png") })
    await page.locator('[data-nav="front-desk"]').click()
    await expect(page.locator(companion)).not.toHaveClass(/closed/)
    await expect(page.locator(info)).toHaveCount(0)
    await expect(page.getByRole("separator", { name: "Resize info panel" })).toHaveCount(0)
    if (shots) await page.screenshot({ path: path.join(shots, "open-docked.png") })
    await page.locator('[data-nav="front-desk"]').click()
    await expect(page.locator(companion)).toHaveClass(/closed/)
    await expect(page.locator(info)).toHaveCount(1)
    assert.equal(await width(page, info), 300, "info panel back at its own width")
    await expect(editor).toHaveValue("draft kept while the chat opens")
    assert(Math.abs(await scroller.evaluate(el => Math.round(el.scrollTop)) - scrollBefore) <= 2, "transcript scroll kept")
  })
  for (const dir of ["ltr", "rtl"]) await check(`resize ${dir}`, { dir }, async page => {
    await page.locator('[data-nav="front-desk"]').click()
    await expect(page.locator(companion)).not.toHaveClass(/closed/)
    const handle = page.getByRole("separator", { name: "Resize Front desk chat" })
    // The handle has no layout width (it sits on the seam); it exists and takes focus.
    await expect(handle).toHaveCount(1)
    const start = await width(page, companion)
    assert.equal(start, 380, "default width")
    // The handle sits on the companion's inline-start edge.
    const [edge, seam] = await page.evaluate(({ companion }) => {
      const rtl = getComputedStyle(document.documentElement).direction === "rtl"
      const box = document.querySelector(companion).getBoundingClientRect()
      return [document.querySelector('.drag-handle[data-side="companion"]').getBoundingClientRect().left, rtl ? box.right : box.left]
    }, { companion })
    assert(Math.abs(edge - seam) <= 1, `handle on the seam ${edge} vs ${seam}`)
    // Pointer: moving the edge toward the content by 80px widens the chat by 80px, live while dragging.
    const out = dir === "rtl" ? 1 : -1
    const y = 450
    await page.mouse.move(seam, y)
    await page.mouse.down()
    await page.mouse.move(seam + out * 40, y, { steps: 2 })
    assert.equal(await width(page, companion), start + 40, "resizes live while dragging")
    await page.mouse.move(seam + out * 80, y, { steps: 2 })
    await page.mouse.up()
    assert.equal(await width(page, companion), start + 80, "follows the pointer")
    // Bounds.
    await page.mouse.move(seam + out * 80, y); await page.mouse.down(); await page.mouse.move(seam - out * 2000, y, { steps: 3 }); await page.mouse.up()
    assert.equal(await width(page, companion), 300, "clamps at the minimum")
    // Keyboard: the arrow pointing toward the content widens; End jumps to the maximum.
    await handle.focus()
    await page.keyboard.press(dir === "rtl" ? "ArrowRight" : "ArrowLeft")
    assert.equal(await width(page, companion), 316, "arrow toward the content widens by 16")
    await expect(handle).toHaveAttribute("aria-valuenow", "316")
    await page.keyboard.press("End")
    assert.equal(await width(page, companion), 720, "End goes to the maximum")
    assert.equal(await page.evaluate(() => localStorage.getItem("es-app-companion-width")), "720", "width remembered")
    if (shots) await page.screenshot({ path: path.join(shots, `resized-${dir}.png`) })
  })
  await check("width restored on reload", { stored: 512 }, async page => {
    await page.locator('[data-nav="front-desk"]').click()
    await expect(page.locator(companion)).not.toHaveClass(/closed/)
    assert.equal(await width(page, companion), 512)
  })
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("companion-resize: PASS")

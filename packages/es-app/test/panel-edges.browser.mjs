// Panel edges (dotfiles#240): each resize handle sits on its panel's seam (the nav's and the info panel's
// edge), takes no layout width, and is hit only in a narrow strip centred on that seam; the chat column has
// equal gutters on both sides. Dragging moves the edge with the pointer (mirrored in RTL), within bounds;
// arrow keys move it the way they point. LTR, forced RTL, RTL with Arabic text, mixed text, zoom.
// Disposable fixture. Run from packages/es-app: node test/panel-edges.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const HIT = 10 // widest acceptable hit strip, px

const open = async ({ width, height, dir = "ltr", lang = "en", title }) => {
  const context = await browser.newContext({ viewport: { width, height } })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await context.addInitScript(() => { try { localStorage.removeItem("es-app-left-width"); localStorage.removeItem("es-app-right-width"); localStorage.setItem("es-app-right-open", "1") } catch {} })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 120_000 })
  await page.evaluate(({ dir, lang, title }) => {
    document.documentElement.dir = dir
    document.documentElement.lang = lang
    if (title) document.querySelector(".session-page .topbar h1, .session-page .session-title")?.replaceChildren(title)
  }, { dir, lang, title })
  await page.waitForTimeout(200)
  return { page, close: () => context.close() }
}

// Seams, handle boxes and the hit strip of each handle, measured by hit-testing across the seam.
const measure = page => page.evaluate(() => {
  const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width } }
  const sidebar = document.querySelector(".shell > .sidebar")
  const main = document.querySelector(".content > .session-page > .session-main")
  const info = document.querySelector(".content > .session-page > .session-info")
  const handles = [...document.querySelectorAll(".drag-handle")]
  const rtl = getComputedStyle(document.documentElement).direction === "rtl"
  // The seam is the panel's inner edge: the nav's inline end, the info panel's inline start.
  const seam = (panel, end) => { const r = rect(panel); return (end !== rtl) ? r.right : r.left }
  const strip = (handle, at) => {
    const y = innerHeight / 2
    const hits = []
    for (let x = Math.floor(at) - 20; x <= Math.ceil(at) + 20; x++) if (document.elementFromPoint(x, y) === handle) hits.push(x)
    return hits.length ? { from: hits[0], to: hits.at(-1), width: hits.length } : undefined
  }
  const text = main.querySelector(".transcript") ?? main
  const content = rect(main)
  const padding = getComputedStyle(main)
  return {
    sidebarSeam: sidebar && seam(sidebar, true), infoSeam: info && seam(info, false),
    handles: handles.map(handle => ({ box: rect(handle), strip: strip(handle, rect(handle).left) })),
    gutters: [parseFloat(padding.paddingInlineStart), parseFloat(padding.paddingInlineEnd)],
    main: content, text: rect(text),
  }
})

let failed = false
const check = async (name, options) => {
  const view = await open(options)
  try {
    const before = await measure(view.page)
    console.log(`${name} ${JSON.stringify(before)}`)
    if (shots) await view.page.screenshot({ path: path.join(shots, `${name}.png`) })
    assert.equal(before.handles.length, 2, `${name}: two resize handles`)
    const [left, right] = before.handles
    // On the seam, no layout width, hit only in a narrow strip around the seam.
    for (const [label, handle, seam] of [["nav", left, before.sidebarSeam], ["info", right, before.infoSeam]]) {
      assert(Math.abs(handle.box.left - seam) <= 1, `${name}: ${label} handle on its seam ${JSON.stringify({ handle: handle.box, seam })}`)
      assert(handle.box.width <= 1, `${name}: ${label} handle takes no layout width ${JSON.stringify(handle.box)}`)
      assert(handle.strip && handle.strip.width <= HIT && handle.strip.from <= seam && handle.strip.to >= seam - 1,
        `${name}: ${label} hit strip is narrow and covers the seam ${JSON.stringify({ strip: handle.strip, seam })}`)
    }
    // Equal chat gutters: the chat column meets both seams with the same inner padding.
    assert(Math.abs(before.gutters[0] - before.gutters[1]) <= 0.5, `${name}: equal chat gutters ${JSON.stringify(before.gutters)}`)
    const nearStart = options.dir === "rtl" ? before.infoSeam : before.sidebarSeam
    const nearEnd = options.dir === "rtl" ? before.sidebarSeam : before.infoSeam
    assert(Math.abs(before.main.left - nearStart) <= 1 && Math.abs(before.main.right - nearEnd) <= 1, `${name}: chat column spans seam to seam ${JSON.stringify(before)}`)

    // Pointer: dragging the nav edge 60px away from the nav widens it by 60px, then clamps at its bound.
    const out = options.dir === "rtl" ? -1 : 1
    const y = options.height / 2
    const navWidth = () => view.page.locator(".shell > .sidebar").evaluate(el => Math.round(el.getBoundingClientRect().width))
    const start = await navWidth()
    await view.page.mouse.move(before.sidebarSeam, y)
    await view.page.mouse.down()
    await view.page.mouse.move(before.sidebarSeam + out * 60, y, { steps: 4 })
    await view.page.mouse.up()
    assert(Math.abs(await navWidth() - (start + 60)) <= 1, `${name}: nav follows the pointer (${start} -> ${await navWidth()})`)
    await view.page.mouse.move(before.sidebarSeam + out * 60, y)
    await view.page.mouse.down()
    await view.page.mouse.move(before.sidebarSeam + out * 2000, y, { steps: 4 })
    await view.page.mouse.up()
    assert.equal(await navWidth(), 480, `${name}: nav clamps at its maximum`)

    // Keyboard: the separator is focusable; the arrow pointing away from the info panel's side widens it.
    const separator = view.page.getByRole("separator", { name: "Resize info panel" })
    const infoWidth = () => view.page.locator(".content > .session-page > .session-info").evaluate(el => Math.round(el.getBoundingClientRect().width))
    const infoStart = await infoWidth()
    await separator.focus()
    await expect(separator).toBeFocused()
    await view.page.keyboard.press(options.dir === "rtl" ? "ArrowRight" : "ArrowLeft")
    assert.equal(await infoWidth(), infoStart + 16, `${name}: arrow toward the chat widens the info panel`)
    await expect(separator).toHaveAttribute("aria-valuenow", String(infoStart + 16))
    console.log(`PASS ${name}`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${error.message}`)
  } finally {
    await view.close()
  }
}

try {
  await check("ltr-1440", { width: 1440, height: 900 })
  await check("ltr-1280", { width: 1280, height: 800 })
  await check("zoom125-1152", { width: 1152, height: 720 })
  await check("forced-rtl-1440", { width: 1440, height: 900, dir: "rtl" })
  await check("arabic-rtl-1280", { width: 1280, height: 800, dir: "rtl", lang: "ar", title: "مراجعة الواجهة — es-app v2" })
  await check("mixed-ltr-1280", { width: 1280, height: 800, title: "Review مراجعة sidebar edges" })
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("panel-edges: PASS")

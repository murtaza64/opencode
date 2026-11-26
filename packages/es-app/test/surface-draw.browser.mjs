// Draw on a Surface (Loupe item 2): Draw is enabled only when the comment store lists "marks"; one button draws with
// the last shape and fans out pen/arrow/box/circle; strokes collect into one draft (Undo, Esc), and Save posts an
// anchor-frame mark on the whole document (ref "surface") with an optional comment. At rest drawings are half
// strength; a store refusal is a failed draft with Retry. Real bridge in a sandboxed fixture frame, fixture store.
// Run from packages/es-app: node test/surface-draw.browser.mjs [--shots <dir>]
import path from "node:path"
import { createRequire } from "node:module"
import { injectBridge } from "../surface-bridge.ts"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const SURFACE = { id: "review", title: "Design review", summary: null, kind: "path", owner: "Relay", lane: "ux-feel", editspace: "fixture", updated_at: now, revision: 2, health: { state: "ok" } }
const PAGE = injectBridge(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{font:15px sans-serif;margin:24px;background:#16161a;color:#ddd} section{margin:0 0 28px} table{border-collapse:collapse} td{border:1px solid #555;padding:6px 14px}</style></head><body>
<h1>Design review</h1>
<section data-anchor="sec/cards"><h2>Decision cards</h2><p id="cards-copy">Cards lead with the question and one recommended option.</p></section>
<section data-anchor="sec/costs"><h2>Costs</h2><table id="costs"><tr><td>Mini</td><td>$12</td><td>$14</td></tr><tr><td>Laptop</td><td>$9</td><td>$31</td></tr></table></section>
<section><h2>Notes</h2><p>Space to draw on.</p><div style="height:260px"></div></section>
</body></html>`)
const shape = (tool, pts) => ({ tool, pts })
const store = { comments: [], posts: [], reject: false }
const comment = (body, at) => ({ comment_id: body.comment_id, surface_id: "review", revision: body.revision, anchor: body.anchor, author: { role: "operator", name: "Murtaza" }, body: body.body, created_at: at, parent_id: null, state: "open", routing: { state: "pending" }, ...(body.mark ? { mark: body.mark } : {}) })
store.comments.push(comment({ comment_id: "element0001", revision: 2, anchor: { id: "sec/cards" }, body: "Lead with the recommendation" }, now - 90_000))
store.comments.push(comment({ comment_id: "point000001", revision: 2, anchor: { id: "costs", selector: "#costs" }, body: "This laptop number looks wrong", mark: { frame: "anchor", ref: "costs", state: "", s: "", shapes: [shape("pin", [0.82, 0.75])] } }, now - 60_000))
store.comments.push(comment({ comment_id: "drawing0001", revision: 2, anchor: { rect: { x: 0.45, y: 0.3, w: 0.3, h: 0.12 } }, body: "Move this up", mark: { frame: "anchor", ref: "surface", state: "", s: "", shapes: [shape("ellipse", [0.45, 0.3, 0.75, 0.42])] } }, now - 30_000))

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, isMobile: !!options.mobile, hasTouch: !!options.mobile, deviceScaleFactor: shots ? 2 : 1 })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } }))
  await page.route("**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } }))
  await page.route("**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" }, body: PAGE }))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces/review/comments", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") return route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "review", capabilities: options.capabilities ?? ["comments", "marks", "view"], comments: store.comments } })
    const body = request.postDataJSON()
    store.posts.push(body)
    // The store's own bounds check, as es_dashboard_surface_comments refuses an out-of-range mark.
    if (store.reject) return route.fulfill({ status: 400, json: { error: "mark coordinates are finite numbers in -1..2" } })
    store.comments.push(comment(body, Date.now()))
    return route.fulfill({ json: { schema: "es-surface-comments/1", comment: store.comments.at(-1), receipt: { state: "stored", duplicate: false } } })
  })
  await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.getByRole("button", { name: /^Comment \(C\)/ })).toBeEnabled({ timeout: 120_000 })
  return { page, context, errors, frame: page.frameLocator(".desk-surface-frame") }
}
// A drag on the draw layer, in stage coordinates.
const drag = async (page, from, to, steps = 6) => {
  const stage = await page.locator(".surface-stage").boundingBox()
  await page.mouse.move(stage.x + from[0], stage.y + from[1])
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(stage.x + from[0] + (to[0] - from[0]) * i / steps, stage.y + from[1] + (to[1] - from[1]) * i / steps + (i % 2) * 6)
  await page.mouse.up()
}

try {
  {
    // A store without marks: Draw and Undo stay disabled, nothing drawn.
    const { page, context, errors } = await open({ width: 1400, height: 900 }, { capabilities: ["comments"] })
    await expect(page.getByRole("button", { name: /^Draw \(D\)/ })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Undo last shape" })).toBeDisabled()
    await expect(page.locator(".sc-drawing[data-comment]")).toHaveCount(0)
    expect(errors).toEqual([])
    await context.close()
  }
  {
    const { page, context, errors } = await open({ width: 1400, height: 900 })
    // At rest: the stored drawing at half strength, beside a pin and an element pip.
    const stored = page.locator('.sc-drawing[data-comment="drawing0001"]')
    await expect(stored).toHaveCount(1)
    await expect(stored.locator("ellipse")).toHaveCount(2)
    await expect(stored).toHaveCSS("opacity", "0.5")
    await expect(page.locator('.sc-peek[data-kind="point"]')).toHaveCount(1)
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "draw-desktop-rest.png") })
    // Opening the drawing's thread draws it at full strength and says what it is.
    await page.locator('.sc-peek[data-comment="drawing0001"]').click()
    await expect(stored).toHaveCSS("opacity", "1")
    await expect(page.locator(".sc-mark-line")).toHaveText("Murtaza · circle on this page")
    await page.keyboard.press("Escape")

    // The fan-out offers the four shapes; Box starts drawing.
    const draw = page.getByRole("button", { name: /^Draw \(D\)/ })
    await expect(draw).toBeEnabled()
    await draw.hover()
    await expect(page.locator(".sc-fly-draw")).toBeVisible()
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "draw-desktop-fan.png") })
    await page.locator(".sc-fly-draw").getByRole("button", { name: "Box" }).click()
    await expect(draw).toHaveAttribute("aria-pressed", "true")
    await expect(page.locator(".sc-draw-layer")).toBeVisible()
    await drag(page, [420, 330], [620, 400])
    await expect(page.locator(".sc-mark-line")).toHaveText("You · box on this page")
    // Undo removes the last shape; a second stroke with the pen.
    await drag(page, [700, 330], [760, 420])
    await expect(page.locator(".sc-mark-line")).toHaveText("You · 2 boxes on this page")
    await page.getByRole("button", { name: "Undo last shape" }).click()
    await expect(page.locator(".sc-mark-line")).toHaveText("You · box on this page")
    await expect(page.locator(".sc-card .sc-send")).toHaveText("Save")
    // The card sits off the draft's shapes (below the box here), never over them.
    const card = await page.locator(".sc-card").boundingBox(), stageBox = await page.locator(".surface-stage").boundingBox()
    expect(card.y).toBeGreaterThanOrEqual(stageBox.y + 400)
    await expect(page.locator(".sc-card .sc-send")).toBeEnabled()
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "draw-desktop-card.png") })
    // Save with no comment: one anchor-frame mark on the whole document, a rect anchor in 0..1.
    await page.locator(".sc-card .sc-send").click()
    await expect.poll(() => store.posts.length).toBe(1)
    const posted = store.posts[0]
    expect(posted.body).toBe("")
    expect(posted.mark.frame).toBe("anchor")
    expect(posted.mark.ref).toBe("surface")
    expect(posted.mark.shapes).toHaveLength(1)
    expect(posted.mark.shapes[0].tool).toBe("rect")
    expect(posted.mark.shapes[0].pts).toHaveLength(4)
    expect(posted.mark.shapes[0].pts.every((value) => value >= -1 && value <= 2)).toBe(true)
    expect(Object.values(posted.anchor.rect).every((value) => value >= 0 && value <= 1)).toBe(true)
    await expect(draw).toHaveAttribute("aria-pressed", "false")
    await page.keyboard.press("Escape")

    // Pick the pen from the fan-out; a pen stroke keeps its points.
    await draw.hover()
    await page.locator(".sc-fly-draw").getByRole("button", { name: "Pen" }).click()
    await drag(page, [420, 470], [640, 520], 12)
    await page.locator(".sc-card textarea").fill("Too much space here")
    // A refusal from the store is a failed draft with Retry, and Retry sends the same bytes.
    store.reject = true
    await page.locator(".sc-card .sc-send").click()
    await expect(page.locator(".sc-out[data-state=failed]")).toContainText("Not sent: mark coordinates are finite numbers in -1..2.")
    store.reject = false
    await page.locator(".sc-out").getByRole("button", { name: "Retry" }).click()
    await expect.poll(() => store.posts.length).toBe(3)
    expect(store.posts[2]).toEqual(store.posts[1])
    expect(store.posts[2].mark.shapes[0].tool).toBe("pen")
    expect(store.posts[2].mark.shapes[0].pts.length).toBeGreaterThanOrEqual(8)
    await page.keyboard.press("Escape")

    // Esc cancels a drawing in progress: nothing posted, draw mode off.
    await page.keyboard.press("d")
    await drag(page, [420, 600], [520, 650])
    await page.keyboard.press("Escape")
    await expect(page.locator(".sc-draw-layer")).toHaveCount(0)
    await expect(page.locator(".sc-card")).toHaveCount(0)
    expect(store.posts.length).toBe(3)
    // The finder names the drawing.
    await page.getByRole("button", { name: "Find a comment (F)" }).click()
    await expect(page.locator('.sc-tray-row[data-comment="drawing0001"] .sc-row-where')).toHaveText("on “this page” · circle")
    expect(errors).toEqual([])
    await context.close()
  }
  {
    // Phone: long-press opens the shape fan-out; drawings rest on the page.
    const { page, context, errors } = await open({ width: 390, height: 844 }, { mobile: true })
    await expect(page.locator('.sc-drawing[data-comment="drawing0001"]')).toHaveCount(1)
    const draw = page.getByRole("button", { name: /^Draw \(D\)/ })
    await draw.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true })
    await page.waitForTimeout(550)
    await expect(page.locator(".sc-draw-tool")).toHaveAttribute("data-open", "")
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "draw-phone-fan.png") })
    expect(errors).toEqual([])
    await context.close()
  }
  console.log("surface-draw: PASS")
} finally {
  await browser.close()
  await preview.close()
}

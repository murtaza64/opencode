// Comment modes (Loupe item 7): the comment button fans out Element | Point; click = the last-used mode, Alt-click
// flips it once. A point comment is stored as one anchor-frame pin mark on its element anchor and rests as a pin on
// the spot; an element comment rests as a ring plus its corner bubble. Point needs the frame's point picks
// (surface-bridge 1.4.0) and a store that advertises "marks". Real bridge in a sandboxed fixture frame, fixture store.
// Run from packages/es-app: node test/surface-comments-point.browser.mjs [--shots <dir>]
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
</body></html>`)
const pin = (x, y, ref) => ({ frame: "anchor", ref, state: "", s: "", shapes: [{ tool: "pin", pts: [x, y] }] })
const store = { capabilities: ["comments", "marks", "view"], comments: [], posts: [] }
const comment = (body, at) => ({ comment_id: body.comment_id, surface_id: "review", revision: body.revision, anchor: body.anchor, author: { role: "operator", name: "Murtaza" }, body: body.body, created_at: at, parent_id: null, state: "open", routing: { state: "pending" }, ...(body.mark ? { mark: body.mark } : {}) })
store.comments.push(comment({ comment_id: "element0001", revision: 2, anchor: { id: "sec/cards" }, body: "Lead with the recommendation" }, now - 60_000))
store.comments.push(comment({ comment_id: "point000001", revision: 2, anchor: { id: "costs", selector: "#costs" }, body: "This laptop number looks wrong", mark: pin(0.82, 0.75, "costs") }, now - 30_000))

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, isMobile: !!options.mobile, hasTouch: !!options.mobile, deviceScaleFactor: shots ? 2 : 1 })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } }))
  await page.route("**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } }))
  await page.route("**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" }, body: PAGE }))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces/review/comments", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") return route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "review", capabilities: options.capabilities ?? store.capabilities, comments: store.comments } })
    const body = request.postDataJSON()
    store.posts.push(body)
    store.comments.push(comment(body, Date.now()))
    return route.fulfill({ json: { schema: "es-surface-comments/1", comment: store.comments.at(-1), receipt: { state: "stored", duplicate: false } } })
  })
  await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.getByRole("button", { name: /^Comment \(C\)/ })).toBeEnabled({ timeout: 120_000 })
  return { page, context, errors, frame: page.frameLocator(".desk-surface-frame") }
}

try {
  {
    const { page, context, errors, frame } = await open({ width: 1400, height: 900 })
    // At rest: the element comment rings its part with its bubble at the corner; the point comment is a pin on its spot.
    const element = page.locator('.sc-peek[data-comment="element0001"]')
    const point = page.locator('.sc-peek[data-comment="point000001"]')
    await expect(element).toHaveAttribute("data-kind", "element")
    await expect(point).toHaveAttribute("data-kind", "point")
    // The pip sits outside the part's top-left corner; the ring shows only while the pip is hovered.
    const ring = page.locator(".sc-rest-ring")
    await expect(ring).toHaveCount(1)
    await expect(ring).toHaveCSS("opacity", "0")
    const part = await frame.locator('[data-anchor="sec/cards"]').boundingBox()
    const pip = await element.boundingBox()
    // Outside the part: left of it or above it (near the stage edge it moves up rather than over the text).
    expect(pip.x + pip.width <= part.x + 1 || pip.y + pip.height <= part.y + 1).toBe(true)
    await element.hover()
    await expect(ring).toHaveCSS("opacity", "1")
    await page.mouse.move(1380, 20)
    await expect(ring).toHaveCSS("opacity", "0")
    const table = await frame.locator("#costs").boundingBox()
    const stage = await page.locator(".surface-stage").boundingBox()
    const tip = await point.boundingBox()
    const frameBox = await page.locator(".desk-surface-frame").boundingBox()
    // The pin's tip (bottom centre) sits on the stored spot: 82% across, 75% down the table.
    expect(Math.abs(tip.x + tip.width / 2 - (table.x + 0.82 * table.width))).toBeLessThan(3)
    expect(Math.abs(tip.y + tip.height - (table.y + 0.75 * table.height))).toBeLessThan(3)
    expect(tip.width).toBeLessThanOrEqual(24)
    await expect(point).toHaveCSS("opacity", "0.85")
    expect(frameBox.y).toBeGreaterThanOrEqual(stage.y)
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "point-desktop-rest.png") })
    // A focused point thread: the ring around its part and its pin at full strength.
    await point.click()
    await expect(page.locator(".sc-ring")).toBeVisible()
    await expect(page.locator(".sc-spot")).toBeVisible()
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "point-desktop-focused.png") })
    await page.keyboard.press("Escape")
    await expect(page.locator(".sc-card")).toHaveCount(0)

    // The fan-out offers both modes on hover; Point picks the exact spot and stores it as a pin mark.
    const main = page.locator(".sc-tool-main")
    await expect(main).toHaveAttribute("data-mode", "element")
    await main.hover()
    await expect(page.locator(".sc-fly-comment")).toBeVisible()
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "point-desktop-fan.png") })
    await page.locator(".sc-fly-comment").getByRole("button", { name: /Point/ }).click()
    await expect(frame.locator("html")).toHaveCSS("cursor", "crosshair")
    const copy = await frame.locator("#cards-copy").boundingBox()
    await frame.locator("#cards-copy").click({ position: { x: copy.width * 0.3, y: copy.height * 0.5 } })
    await expect(page.locator(".sc-card textarea")).toHaveAttribute("placeholder", "Comment on this spot…")
    await expect(page.locator(".sc-spot")).toBeVisible()
    await page.locator(".sc-card textarea").fill("Name the option here")
    await page.locator(".sc-card textarea").press("Meta+Enter")
    await expect.poll(() => store.posts.length).toBe(1)
    const posted = store.posts[0]
    expect(posted.anchor.id).toBe("cards-copy")
    expect(posted.mark.frame).toBe("anchor")
    expect(posted.mark.ref).toBe("cards-copy")
    expect(posted.mark.shapes).toHaveLength(1)
    expect(posted.mark.shapes[0].tool).toBe("pin")
    expect(posted.mark.shapes[0].pts[0]).toBeCloseTo(0.3, 1)
    expect(posted.mark.shapes[0].pts[1]).toBeCloseTo(0.5, 1)
    await page.keyboard.press("Escape")

    // The mode is remembered; Alt-click flips it for one comment (an element comment, no mark).
    await expect(main).toHaveAttribute("data-mode", "point")
    await main.click({ modifiers: ["Alt"] })
    await frame.locator("#costs").click({ position: { x: 4, y: 4 } })
    await expect(page.locator(".sc-card textarea")).toHaveAttribute("placeholder", "Comment on this part…")
    await page.locator(".sc-card textarea").fill("Whole table")
    await page.locator(".sc-card textarea").press("Meta+Enter")
    await expect.poll(() => store.posts.length).toBe(2)
    expect("mark" in store.posts[1]).toBe(false)
    await page.keyboard.press("Escape")
    await expect(main).toHaveAttribute("data-mode", "point")

    // The finder row names the part and marks point comments.
    await page.getByRole("button", { name: "Find a comment (F)" }).click()
    await expect(page.locator('.sc-tray-row[data-comment="point000001"] .sc-row-where')).toHaveText("on “costs” · point")
    await expect(page.locator('.sc-tray-row[data-comment="element0001"] .sc-row-where')).toHaveText("on “sec/cards”")
    expect(errors).toEqual([])
    await context.close()
  }
  {
    // A store without marks: Point is offered but disabled, and the button picks elements.
    const { page, context, errors } = await open({ width: 1400, height: 900 }, { capabilities: ["comments"] })
    await page.locator(".sc-tool-main").hover()
    await expect(page.locator(".sc-fly-comment").getByRole("button", { name: /Point/ })).toBeDisabled()
    await expect(page.locator(".sc-tool-main")).toHaveAttribute("data-mode", "element")
    expect(errors).toEqual([])
    await context.close()
  }
  {
    // Phone: a long press opens the fan-out; pins and rings still rest on their parts.
    const { page, context, errors } = await open({ width: 390, height: 844 }, { mobile: true })
    await expect(page.locator('.sc-peek[data-comment="point000001"]')).toBeVisible()
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "point-phone-rest.png") })
    await page.locator(".sc-tool-main").dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true })
    await page.waitForTimeout(550)
    await expect(page.locator(".sc-comment")).toHaveAttribute("data-open", "")
    await expect(page.locator(".sc-fly-comment")).toBeVisible()
    if (shots) await page.locator(".surface-stage").screenshot({ path: path.join(shots, "point-phone-fan.png") })
    expect(errors).toEqual([])
    await context.close()
  }
  console.log("surface-comments-point: PASS")
} finally {
  await browser.close()
  await preview.close()
}

// On-surface comments in the Surface reader (DD #519 M1), against a sandboxed fixture frame carrying the real bridge
// (surface-bridge.ts) and a fixture store in the es-surface-comments/1 shape (remote-host-client #530).
// Cases: add by mouse and by keyboard; expand with the dimmed, blurred surround; reply; Esc returns focus; hide all;
// offline send then one retry with the same id; reduced motion; another revision's comment; RTL at 390px.
// Run from packages/es-app.
import { createRequire } from "node:module"
import { injectBridge } from "../surface-bridge.ts"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const SURFACE = { id: "review", title: "Design review", summary: null, kind: "path", owner: "opencode/ux-feel", lane: "ux-feel", editspace: "opencode", updated_at: now, revision: 2, health: { state: "ok" } }
const PAGE = injectBridge(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{font:15px sans-serif;margin:24px;background:#16161a;color:#ddd} section{margin:0 0 28px}</style></head><body>
<h1>Design review</h1>
<section data-anchor="sec/cards"><h2>Decision cards</h2><p id="cards-copy">Cards lead with the question and one recommended option.</p></section>
<section data-anchor="sec/chips"><h2>Mail chips</h2><p>Each chip shows a kind icon and who.</p><ul><li>Hover shows the lane</li><li>Compact turns fold</li></ul></section>
<section><h2>Open questions</h2><p>Which states need their own colour?</p></section>
</body></html>`)

// The comment store, as the dashboard answers it.
const store = { comments: [], posts: [], dropNext: false }
const comment = (body, at) => ({ comment_id: body.comment_id, surface_id: "review", revision: body.revision, anchor: body.anchor, author: { role: "operator", name: "Murtaza" }, body: body.body, created_at: at, parent_id: body.parent_id ?? null, state: "open", routing: { state: "pending" } })
store.comments.push(comment({ comment_id: "oldrev00001", revision: 1, anchor: { id: "sec/cards" }, body: "From revision 1" }, now - 3_600_000))

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: options.reducedMotion ?? "no-preference" })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [SURFACE] } }))
  await page.route("**/__es/surface/review", (route) => route.fulfill({ json: { src: "/__fixture/review/", expires_at: now + 600_000 } }))
  // An opaque-origin frame, as the Surface proxy serves it.
  await page.route("**/__fixture/review/", (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": "sandbox allow-scripts allow-forms" }, body: PAGE }))
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces/review/comments", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") return route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "review", comments: store.comments } })
    const body = request.postDataJSON()
    store.posts.push(body)
    if (store.dropNext) { store.dropNext = false; return route.abort("internetdisconnected") }
    const prior = store.comments.find((item) => item.comment_id === body.comment_id)
    if (!prior) store.comments.push(comment(body, Date.now()))
    return route.fulfill({ json: { schema: "es-surface-comments/1", comment: prior ?? store.comments.at(-1), receipt: { state: "stored", duplicate: !!prior } } })
  })
  await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(page.locator(".sc-tool-main")).toBeEnabled({ timeout: 120_000 })
  return { page, context, errors, frame: page.frameLocator(".desk-surface-frame") }
}

try {
  {
    const { page, context, errors, frame } = await open({ width: 1400, height: 900 })
    // Another revision's comment gets no marker and is listed as elsewhere.
    await expect(page.locator(".sc-peek")).toHaveCount(0)
    await expect(page.locator(".sc-tool-note")).toHaveText("1 not on this view")

    // Mouse: Comment, hover, click a section heading's paragraph.
    await page.locator(".sc-tool-main").click()
    await expect(page.locator(".sc-tool-hint")).toBeVisible()
    await frame.locator("#cards-copy").hover()
    await frame.locator("#cards-copy").click()
    await expect(page.locator(".sc-focus .sc-dim")).toHaveCount(4)
    await page.locator(".sc-compose textarea").fill("Lead with the recommendation, not the question.")
    await page.locator(".sc-send").click()
    await expect(page.locator(".sc-thread .sc-comment")).toHaveCount(1)
    await expect(page.locator(".sc-receipt")).toContainText("Saved · goes to the owner")
    const first = store.posts.at(-1)
    expect(first).toMatchObject({ revision: 2, body: "Lead with the recommendation, not the question.", anchor: { id: "cards-copy" } })
    expect(first.anchor.selector).toBeTruthy()
    expect(first.anchor.hash).toMatch(/^[0-9a-f]{8}$/)
    expect(first.comment_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    await page.screenshot({ path: "/tmp/surface-comments-expanded.png" })

    // Reply inline, then Esc closes and returns focus to the marker.
    await page.locator(".sc-compose textarea").fill("Agreed; drop the eyebrow too.")
    await page.locator(".sc-compose textarea").press("Meta+Enter")
    await expect(page.locator(".sc-thread .sc-comment")).toHaveCount(2)
    expect(store.posts.at(-1)).toMatchObject({ parent_id: first.comment_id, anchor: first.anchor })
    await page.keyboard.press("Escape")
    await expect(page.locator(".sc-focus")).toHaveCount(0)
    await expect(page.locator(`.sc-peek[data-comment="${first.comment_id}"]`)).toBeFocused()
    await expect(page.locator(".sc-peek .sc-peek-count")).toHaveText("2")
    await expect(page.locator(".desk-surface-frame")).toHaveCount(1)
    await page.screenshot({ path: "/tmp/surface-comments-peek.png" })

    // Expanding blurs and dims everything around the anchor.
    await page.locator(".sc-peek").click()
    expect(await page.locator(".sc-dim").first().evaluate((el) => getComputedStyle(el).backdropFilter)).toContain("blur")
    await page.locator(".sc-text-button", { hasText: "Close" }).click()

    // Keyboard: C (outside the frame), arrows, Enter, then ⌘↵.
    await page.locator(".surface-head h2").click()
    await page.keyboard.press("c")
    await expect(page.locator(".sc-tool-hint")).toBeVisible()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")
    await expect(page.locator(".sc-compose textarea")).toBeFocused()
    await page.keyboard.type("Keyboard comment")
    await page.keyboard.press("Meta+Enter")
    await expect(page.locator(".sc-thread .sc-comment")).toHaveCount(1)
    expect(store.posts.at(-1).body).toBe("Keyboard comment")
    await page.keyboard.press("Escape")
    await expect(page.locator(".sc-peek")).toHaveCount(2)

    // Hide all, then show again; nothing is lost.
    await page.locator(".sc-tool", { hasText: "Hide" }).click()
    await expect(page.locator(".sc-peek")).toHaveCount(0)
    await page.locator(".sc-tool", { hasText: "Show" }).click()
    await expect(page.locator(".sc-peek")).toHaveCount(2)

    // Offline: the send fails, the text stays, and one Retry sends the same id and body.
    await page.locator(".sc-tool-main").click()
    await frame.locator("li").first().click()
    await page.locator(".sc-compose textarea").fill("Sent while offline")
    store.dropNext = true
    await page.locator(".sc-send").click()
    await expect(page.locator(".sc-out[data-state=failed]")).toContainText("Not sent")
    const dropped = store.posts.at(-1)
    await page.locator(".sc-out .sc-text-button", { hasText: "Retry" }).click()
    await expect(page.locator(".sc-out")).toHaveCount(0)
    expect(store.posts.at(-1)).toEqual(dropped)
    await expect(page.locator(".sc-thread .sc-comment")).toHaveCount(1)
    await page.keyboard.press("Escape")

    // Esc during pick mode leaves pick mode, not the Surface.
    await page.locator(".sc-tool-main").click()
    await page.keyboard.press("Escape")
    await expect(page.locator(".sc-tool-hint")).toHaveCount(0)
    await expect(page.locator(".desk-surface-frame")).toHaveCount(1)
    expect(errors).toEqual([])
    await context.close()
  }
  {
    // Reduced motion: dim only, no blur.
    const { page, context } = await open({ width: 1200, height: 800 }, { reducedMotion: "reduce" })
    await page.locator(".sc-peek").first().click()
    expect(await page.locator(".sc-dim").first().evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none")
    await context.close()
  }
  {
    // RTL at 390px: the toolbar spans the bottom, the card stays inside the frame.
    const { page, context, errors } = await open({ width: 390, height: 844 })
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await expect(page.locator(".sc-peek")).toHaveCount(3)
    await page.locator(".sc-peek").first().click()
    const stage = await page.locator(".surface-stage").boundingBox()
    const card = await page.locator(".sc-card").boundingBox()
    expect(card.x).toBeGreaterThanOrEqual(stage.x)
    expect(card.x + card.width).toBeLessThanOrEqual(stage.x + stage.width + 1)
    await expect(page.locator(".sc-toolbar")).toBeVisible()
    await page.screenshot({ path: "/tmp/surface-comments-rtl-390.png" })
    expect(errors).toEqual([])
    await context.close()
  }
  {
    // A long thread on a low anchor in a short frame: the card takes the side with room, never runs past the stage,
    // and keeps its reply box and actions on screen while the thread scrolls inside (MCR staging, 820px touch).
    const root = comment({ comment_id: "longthread01", revision: 2, anchor: { rect: { x: 0.05, y: 0.9, w: 0.5, h: 0.04 } }, body: "Root of a long thread" }, now - 600_000)
    store.comments.push(root, ...Array.from({ length: 7 }, (_, index) => comment({ comment_id: `longreply0${index}`, revision: 2, anchor: root.anchor, parent_id: root.comment_id, body: `Reply ${index + 1}: ${"a fairly long sentence ".repeat(4)}` }, now - 500_000 + index)))
    const { page, context, errors } = await open({ width: 820, height: 600 })
    await page.locator('.sc-peek[data-comment="longthread01"]').click()
    const stage = await page.locator(".surface-stage").boundingBox()
    const card = await page.locator(".sc-card").boundingBox()
    expect(card.y).toBeGreaterThanOrEqual(stage.y - 1)
    expect(card.y + card.height).toBeLessThanOrEqual(stage.y + stage.height + 1)
    await expect(page.locator(".sc-send")).toBeInViewport()
    await expect(page.locator(".sc-thread .sc-comment").last()).toBeInViewport()
    await page.screenshot({ path: "/tmp/surface-comments-long-thread.png" })
    expect(errors).toEqual([])
    await context.close()
  }
  console.log("surface-comments: PASS")
} finally {
  await browser.close()
  await preview.close()
}

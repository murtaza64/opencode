// On-surface comments in the Surface reader (DD #519 M1), against a sandboxed fixture frame carrying the real bridge
// (surface-bridge.ts) and a fixture store in the es-surface-comments/1 shape (remote-host-client #530).
// Cases: post, reply, finder, off-view, navigation, tuck, non-modal veil, retry and RTL.
// Run from packages/es-app.
import { createRequire } from "node:module"
import { injectBridge } from "../surface-bridge.ts"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const SURFACE = { id: "review", title: "Design review", summary: null, kind: "path", owner: "Relay", lane: "ux-feel", editspace: "fixture", updated_at: now, revision: 2, health: { state: "ok" } }
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
store.comments.push(comment({ comment_id: "missing00001", revision: 2, anchor: { id: "gone-part", selector: "#gone-part" }, body: "The removed heading" }, now - 3_500_000))

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
  await expect(page.getByRole("button", { name: "Comment (C)" })).toBeEnabled({ timeout: 120_000 })
  return { page, context, errors, frame: page.frameLocator(".desk-surface-frame") }
}

try {
  {
    preview.fixture.laneOwners = [{ lane: "ux-feel", owner: "ses_a" }]
    const { page, context, errors, frame } = await open({ width: 1400, height: 900 })
    const head = page.locator(".surface-head")
    await expect(head.locator("h2")).toHaveText("Design review")
    await expect(head.locator(".surface-head-rev")).toHaveText("rev 2")
    await expect(head.locator(".surface-owner-chip")).toContainText("Relay")
    await expect(head.getByRole("button", { name: "More" })).toBeVisible()
    await expect(head.locator(".surface-head-actions > :is(a, button)")).toHaveCount(1)
    await head.locator(".surface-owner-chip").click()
    await head.getByRole("button", { name: "Open Relay's chat" }).click()
    await expect(page).toHaveURL(/\/session\/ses_a\?directory=/)
    await expect(page.locator(".context-chip[data-kind=surface]")).toContainText("Design review")
    await page.goto(`${preview.origin}/?surface=review`, { waitUntil: "domcontentloaded" })
    await expect(page.locator(".sc-tool-say")).toBeVisible()
    await page.locator(".sc-tool-say").click()
    await expect(page.locator(".sc-say")).toContainText("To Relay · published this · rev 2")
    await page.locator(".sc-say textarea").fill("Please review the opening section")
    await page.locator(".sc-say textarea").press("Meta+Enter")
    await expect(page.locator(".sc-say [role=status]")).toContainText("Sent to Relay")
    const prompts = preview.fixture.calls.filter(call => call.method === "POST" && call.path === "/session/ses_a/prompt_async")
    expect(prompts).toHaveLength(1)
    expect(prompts[0].body.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "Please review the opening section" }), expect.objectContaining({ type: "text", synthetic: true, text: expect.stringContaining('"id":"review"') })]))
    expect(prompts[0].body.parts[1].text).toContain('"revision":2')
    await expect(page.locator(".sc-thread")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.locator(".sc-say")).toHaveCount(0)
    // Off-view threads are available only through the count's finder.
    await expect(page.locator(".sc-peek")).toHaveCount(0)
    await expect(page.locator(".sc-tool-note")).toHaveCount(0)
    const width = await page.locator(".sc-toolbar").evaluate((el) => el.getBoundingClientRect().width)
    await expect(page.getByRole("button", { name: "Draw" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Draw" })).toHaveAttribute("title", "Drawing needs host support (marks)")
    await page.getByRole("button", { name: "Find a comment (F)" }).click()
    await expect(page.locator(".sc-group h3", { hasText: "Not on this view" })).toBeVisible()
    await page.locator(".sc-tool-say").click()
    await expect(page.locator(".sc-tray")).toHaveCount(0)
    await page.getByRole("button", { name: "Find a comment (F)" }).click()
    await expect(page.locator(".sc-say")).toHaveCount(0)
    await page.locator(".sc-tool-say").click()
    await page.keyboard.press("Escape")
    await expect(page.locator(".sc-say")).toHaveCount(0)
    await expect(page.locator(".desk-surface-frame")).toHaveCount(1)
    await page.getByRole("button", { name: "Find a comment (F)" }).click()
    await page.getByRole("button", { name: "From revision 1" }).click()
    await expect(page.locator(".sc-away-tag")).toHaveText("not on this view")
    await expect(page.locator(".sc-away blockquote")).toContainText("sec/cards")
    await expect(page.locator(".sc-veil")).toHaveCount(0)
    await page.locator(".sc-card-nav").getByRole("button", { name: "Next thread (J)" }).click()
    await expect(page.locator(".sc-away blockquote")).toContainText("gone-part")
    await page.keyboard.press("Escape")
    await page.keyboard.press("f")
    await page.getByRole("searchbox", { name: "Find a comment" }).fill("removed heading")
    await expect(page.locator(".sc-tray-row")).toHaveCount(1)
    await page.getByRole("button", { name: /The removed heading/ }).click()
    await expect(page.locator(".sc-away blockquote")).toContainText("gone-part")
    await page.keyboard.press("Escape")

    // Mouse: Comment, hover, click a section heading's paragraph.
    await page.getByRole("button", { name: "Comment (C)" }).click()
    await expect(page.getByRole("button", { name: "Comment (C)" })).toHaveAttribute("aria-pressed", "true")
    expect(await page.locator(".sc-toolbar").evaluate((el) => el.getBoundingClientRect().width)).toBe(width)
    await frame.locator("#cards-copy").hover()
    await frame.locator("#cards-copy").click()
    await expect(page.locator(".sc-focus .sc-veil")).toHaveCount(1)
    await expect(page.locator(".sc-focus")).not.toHaveAttribute("aria-modal", "true")
    await expect(page.locator("[role=dialog][aria-modal=true]")).toHaveCount(0)
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
    const peek = page.locator(`.sc-peek[data-comment="${first.comment_id}"]`)
    await expect(peek).toBeFocused()
    // An anchor report after closing (here a DOM change that moves the anchor) keeps the same focused button.
    await peek.evaluate((el) => { el.dataset.probe = "kept" })
    const top = await peek.evaluate((el) => el.style.top)
    const frameDoc = await (await page.locator(".desk-surface-frame").elementHandle()).contentFrame()
    await frameDoc.evaluate(() => { const spacer = document.createElement("div"); spacer.style.height = "40px"; document.body.prepend(spacer) })
    await expect.poll(() => peek.evaluate((el) => el.style.top)).not.toBe(top)
    await expect(peek).toHaveAttribute("data-probe", "kept")
    await expect(peek).toBeFocused()
    await expect(page.locator(".sc-peek .sc-peek-count")).toHaveText("2")
    await expect(page.locator(".desk-surface-frame")).toHaveCount(1)
    await page.screenshot({ path: "/tmp/surface-comments-peek.png" })

    // Expanding blurs and dims everything around the anchor.
    await page.locator(".sc-peek").click()
    expect(await page.locator(".sc-veil").evaluate((el) => getComputedStyle(el).backdropFilter)).toContain("blur")
    expect(await page.locator(".sc-veil").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none")
    await frame.locator("#cards-copy").evaluate((el) => { el.addEventListener("click", () => { el.dataset.clicked = "yes" }, { once: true }) })
    await frame.locator("#cards-copy").click()
    await expect(frame.locator("#cards-copy")).toHaveAttribute("data-clicked", "yes")
    await page.locator(".sc-peek").first().click()
    await page.locator(".surface-head h2").click()
    await expect(page.locator(".sc-focus")).toHaveCount(0)
    await page.locator(".sc-peek").first().click()
    await page.locator(".sc-text-button", { hasText: "Close" }).click()

    // Keyboard: C (outside the frame), arrows, Enter, then ⌘↵.
    await page.locator(".surface-head h2").click()
    await page.keyboard.press("c")
    await expect(page.getByRole("button", { name: "Comment (C)" })).toHaveAttribute("aria-pressed", "true")
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
    await page.getByRole("button", { name: "Hide comments (H)" }).click()
    await expect(page.locator(".sc-peek")).toHaveCount(0)
    await page.getByRole("button", { name: "Hide comments (H)" }).click()
    await expect(page.locator(".sc-peek")).toHaveCount(2)

    // Finder filters by author, status and search; row hover pings without scrolling.
    await page.getByRole("button", { name: "Find a comment (F)" }).click()
    await page.getByRole("searchbox", { name: "Find a comment" }).fill("")
    await page.getByRole("button", { name: "Filter by Murtaza" }).click()
    await expect(page.locator(".sc-tray-row")).toHaveCount(4)
    await page.getByRole("button", { name: "resolved", exact: true }).click()
    await expect(page.locator(".sc-empty")).toBeVisible()
    await page.getByRole("button", { name: "all", exact: true }).click()
    await page.getByRole("searchbox", { name: "Find a comment" }).fill("recommendation")
    await expect(page.locator(".sc-tray-row")).toHaveCount(1)
    const scroll = await frame.locator("body").evaluate(() => scrollY)
    await page.locator(".sc-tray-row").hover()
    await expect(page.locator(`.sc-peek[data-comment="${first.comment_id}"]`)).toHaveClass(/sc-ping/)
    expect(await frame.locator("body").evaluate(() => scrollY)).toBe(scroll)
    await page.getByRole("searchbox", { name: "Find a comment" }).press("Enter")
    await expect(page.locator(".sc-thread .sc-comment")).toHaveCount(2)
    await page.keyboard.press("Escape")
    await page.keyboard.press("j")
    await expect(page.locator(".sc-focus")).toHaveCount(1)
    const selected = await page.locator(".sc-thread .sc-body").first().textContent()
    await page.locator(".sc-card .sc-text-button", { hasText: "Close" }).focus()
    await page.keyboard.press("k")
    await expect(page.locator(".sc-thread .sc-body").first()).not.toHaveText(selected)
    await page.keyboard.press("Escape")
    await page.keyboard.press(".")
    await expect(page.getByRole("button", { name: "Restore toolbar (.)" })).toBeVisible()
    await page.getByRole("button", { name: "Restore toolbar (.)" }).click()
    await expect(page.locator(".sc-toolbar")).toBeVisible()
    expect(await page.locator(".sc-toolbar").evaluate((el) => el.getBoundingClientRect().width)).toBe(width)

    // Offline: the send fails, the text stays, and one Retry sends the same id and body.
    await page.getByRole("button", { name: "Comment (C)" }).click()
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
    await page.getByRole("button", { name: "Comment (C)" }).click()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("button", { name: "Comment (C)" })).toHaveAttribute("aria-pressed", "false")
    await expect(page.locator(".desk-surface-frame")).toHaveCount(1)
    expect(errors).toEqual([])
    await context.close()
  }
  {
    preview.fixture.laneOwners = []
    const { page, context, frame } = await open({ width: 1200, height: 800 })
    await page.locator(".sc-tool-say").click()
    await page.locator(".sc-say textarea").fill("Keep this unsent")
    await expect(page.locator(".sc-say .sc-send")).toBeDisabled()
    await expect(page.locator(".sc-say")).toContainText("owner of ux-feel not listed on that host now")
    await page.keyboard.press("Escape")
    await page.locator(".sc-tool-say").click()
    await expect(page.locator(".sc-say textarea")).toHaveValue("Keep this unsent")
    await page.keyboard.press("Escape")
    await frame.locator("#cards-copy").click()
    await page.keyboard.press("m")
    await expect(page.locator(".sc-say textarea")).toHaveValue("Keep this unsent")
    await page.keyboard.press("Escape")
    await page.locator(".surface-head h2").click()
    await page.keyboard.press("m")
    await expect(page.locator(".sc-say textarea")).toHaveValue("Keep this unsent")
    expect(preview.fixture.calls.filter(call => call.method === "POST" && call.path.endsWith("/prompt_async"))).toHaveLength(1)
    await context.close()
  }
  {
    // Reduced motion: dim only, no blur.
    const { page, context } = await open({ width: 1200, height: 800 }, { reducedMotion: "reduce" })
    await page.locator(".sc-peek").first().click()
    expect(await page.locator(".sc-veil").evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none")
    await context.close()
  }
  {
    // RTL at 390px: the toolbar stays centered, the card stays inside the frame.
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

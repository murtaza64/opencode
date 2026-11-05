// A Surface update that says what it asks (DD #753): the reader line reads "Since r10 · FYI", the note, "Look at"
// buttons and, when set, "Respond:". Nothing scrolls until a place is clicked; a clicked place scrolls the frame and
// pulses; a place the page lacks says "section not found in r11"; an FYI shows no Done; the Needs you row carries the
// call to action. The frame runs the real surface-bridge. Run from packages/es-app.
import { createRequire } from "node:module"
import { injectBridge } from "../../surface-bridge/src/index.js"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const results = []
const page_html = injectBridge(`<!doctype html><html><head><title>Audit</title></head><body><main><h2>Intro</h2>
  <div style="height:3000px">long</div><h2 id="sources">Sources and repro</h2><p>Rev 9 ran on Kimi-K3.</p></main></body></html>`)
const open = async (page, change, extra = {}) => {
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [{
    id: "audit", title: "Context audit", summary: null, kind: "path", owner: "fixture", lane: null, editspace: "fixture", updated_at: now,
    revision: 11, health: { state: "ok" }, purpose: "deliverable", seen: false, requested_in: { session: "ses_x", directory: "/tmp" },
    whats_new: "Rev 9 ran on Kimi-K3 (per Core), not Opus as first reported", notes: [], change, ...extra }] } }))
  await page.route("**/__es/surface/audit", (route) => route.fulfill({ json: { src: "/__cap/surface/audit/m1-0123456789abcdef0123456789abcdef/", expires_at: now + 600_000 } }))
  await page.route("**/__cap/surface/audit/**", (route) => route.fulfill({ contentType: "text/html", body: page_html }))
  await page.route("**/es/api/surfaces/audit/comments*", (route) => route.fulfill({ json: { schema: "es-surface-comments/1", surface_id: "audit", capabilities: ["comments", "marks", "view"], comments: [] } }))
  await page.goto(`${preview.origin}/?surface=audit`, { waitUntil: "domcontentloaded", timeout: 300_000 })
}
const frameScroll = (page) => page.frames().find((frame) => frame.url().includes("/__cap/surface/audit/"))?.evaluate(() => window.scrollY)
try {
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    await open(page, { base: 10, intent: "fyi", look: [{ label: "Sources and repro", id: "sources" }, { label: "Old table", id: "gone" }], respond: null })
    const change = page.locator(".surface-change")
    await expect(change.locator(".surface-change-label")).toHaveText("Since r10 · FYI", { timeout: 120_000 })
    await expect(change).toContainText("Rev 9 ran on Kimi-K3 (per Core), not Opus as first reported")
    await expect(change.locator(".surface-change-respond")).toHaveCount(0)
    await expect(page.locator(".surface-head .surface-head-done, .surface-head [data-deliverable-done]")).toHaveCount(0)
    await expect(change.locator('[data-look="1"]')).toContainText("(section not found in r11)", { timeout: 30_000 })
    await page.waitForTimeout(800)
    if ((await frameScroll(page)) !== 0) throw new Error("the frame scrolled before any click")
    await change.locator('[data-look="0"]').click()
    await expect.poll(() => frameScroll(page), { timeout: 10_000 }).toBeGreaterThan(1000)
    await expect(page.locator(".sc-look-pulse")).toHaveCount(1)
    await expect(change.locator('[data-look="0"]')).not.toContainText("not found")
    results.push("PASS FYI: Since r10 · FYI + note, no Done, no Respond; no scroll until clicked; a click scrolls and pulses; a missing place says not found in r11")
    // FYI asks nothing: never in Needs you; the Surfaces list carries it as line 2 while unseen.
    await expect(page.locator('[data-kind="try"][data-nav-item="surface:audit"]')).toHaveCount(0)
    await page.locator("#nav-tab-surfaces").click()
    const listed = page.locator('.nav-surface[data-nav-item="surface:audit"]')
    await expect(listed.locator(".nav-change")).toHaveText("Since r10 · FYI · Look at: Sources and repro +1 · Rev 9 ran on Kimi-K3 (per Core), not Opus as first reported")
    results.push("PASS an FYI update stays out of Needs you; the Surfaces row carries its line while unseen")
    await page.close()
  }
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    await open(page, { base: 9, intent: "review", look: [], respond: "Keep the Opus control or rerun on Kimi?" })
    const change = page.locator(".surface-change")
    await expect(change.locator(".surface-change-label")).toHaveText("Since r9 · Review", { timeout: 120_000 })
    await expect(change.locator(".surface-change-respond")).toHaveText("Respond: Keep the Opus control or rerun on Kimi?")
    await expect(change.locator(".surface-change-look")).toHaveCount(0)
    const row = page.locator('[data-kind="try"][data-nav-item="surface:audit"]')
    await expect(row.locator(".kind-badge")).toHaveText("Respond")
    await expect(row.locator(".nav-change")).toHaveText("Keep the Opus control or rerun on Kimi?")
    results.push("PASS review with a question: Since r9 · Review + Respond line; the Needs you row leads with Respond and the question")
    await page.close()
  }
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    await open(page, { base: 10, intent: "review", look: [{ label: "Sources and repro", id: "sources" }], respond: null })
    const row = page.locator('[data-kind="try"][data-nav-item="surface:audit"]')
    await expect(row.locator(".kind-badge")).toHaveText("Review", { timeout: 120_000 })
    await expect(row.locator(".nav-change")).toHaveText("Since r10 · Look at: Sources and repro · Rev 9 ran on Kimi-K3 (per Core), not Opus as first reported")
    results.push("PASS a review update leads its Needs you row with Review and where to look")
    await page.close()
  }
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    await open(page, undefined, { whats_new: null })
    await expect(page.locator(".surface-change")).toContainText("No change note provided", { timeout: 120_000 })
    await expect(page.locator(".surface-change-label")).toHaveText("What's new in rev 11")
    results.push("PASS no note and no change: 'No change note provided', no invented call to action")
    await page.close()
  }
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n").slice(0, 8).join(" | ")}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
}

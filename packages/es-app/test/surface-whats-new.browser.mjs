// A Surface's change note (DD #725 slice 1): the reader shows "What's new in rev N" with the author's note; a
// republish without a note says "No change note provided"; a device that last opened an older revision gets
// "since rev N you last opened" with the earlier notes and the count of missed revisions without one. Run from packages/es-app.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const results = []
const surface = { id: "ops", title: "Ops report", summary: null, kind: "path", owner: "fixture", lane: null, editspace: "fixture",
  updated_at: now, health: { state: "ok" } }
const open = async (page, row) => {
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [{ ...surface, ...row }] } }))
  await page.route("**/__es/surface/ops", (route) => route.fulfill({ json: { src: "/__cap/surface/ops/m1-0123456789abcdef0123456789abcdef/", expires_at: now + 600_000 } }))
  await page.route("**/__cap/surface/ops/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Ops report body</h1>" }))
  await page.goto(`${preview.origin}/?surface=ops`, { waitUntil: "domcontentloaded", timeout: 300_000 })
}
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
  {
    const page = await context.newPage()
    await open(page, { revision: 2, whats_new: "Pick A or B in the header", notes: [{ revision: 2, text: "Pick A or B in the header" }] })
    const change = page.locator(".surface-change")
    await expect(change).toContainText("What's new in rev 2", { timeout: 120_000 })
    await expect(change).toContainText("Pick A or B in the header")
    await expect(change.locator(".surface-change-since")).toHaveCount(0)
    results.push("PASS reader shows the author's note for the revision on screen")
    await page.close()
  }
  {
    // Same device: rev 2 was opened above. Rev 5 arrives with a note on 3 only: missed rev 4 has none, and rev 5 (on screen) says so itself.
    const page = await context.newPage()
    await open(page, { revision: 5, whats_new: null, notes: [{ revision: 3, text: "Header redrawn" }, { revision: 2, text: "Pick A or B in the header" }] })
    const change = page.locator(".surface-change")
    await expect(change).toContainText("No change note provided", { timeout: 120_000 })
    const since = change.locator(".surface-change-since")
    await expect(since).toContainText("since rev 2 you last opened · 1 earlier note")
    await since.click()
    await expect(change.locator(".surface-change-earlier")).toContainText("rev 3 Header redrawn")
    await expect(change.locator(".surface-change-earlier")).toContainText("1 revision with no change note")
    await expect(change).not.toContainText("Pick A or B")
    results.push("PASS a missed-revision reader names its base, lists earlier notes, counts unnoted revisions, never reuses an old note")
    await page.close()
  }
  {
    const page = await context.newPage()
    await open(page, { revision: 1, whats_new: null, notes: [] })
    await expect(page.locator(".surface-head h2")).toBeVisible({ timeout: 120_000 })
    await page.waitForTimeout(300)
    await expect(page.locator(".surface-change")).toHaveCount(0)
    results.push("PASS a first publish without a note shows no change line")
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

// The Surface reader's find bar (DD #672/#676), without Electron. A plain browser keeps Cmd/Ctrl+F native (the reader
// neither prevents it nor opens its bar). With the native find route present (stubbed here with counts only), the
// chord opens the bar in the reader header: query focused, "N of M" / "No matches", Enter / Shift+Enter, Esc closes
// with focus returned and the reader still open, and the bar fits at 390 px in LTR and RTL. Run from packages/es-app.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const now = Date.now()
const results = []
const setup = async (page, native) => {
  await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [
    { id: "ops", title: "Ops report with a long title that has to shrink", summary: null, kind: "path", owner: "fixture", lane: null,
      editspace: "fixture", updated_at: now, revision: 1, health: { state: "ok" } }] } }))
  await page.route("**/__es/surface/ops", (route) => route.fulfill({ json: { src: "/__cap/surface/ops/m1-0123456789abcdef0123456789abcdef/", expires_at: now + 600_000 } }))
  await page.route("**/__cap/surface/ops/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Ops report body</h1>" }))
  const posts = []
  await page.route("**/__es/find", (route) => {
    if (!native) return route.fulfill({ status: 404, body: "Not found" })
    if (route.request().method() === "GET") return route.fulfill({ json: { available: true } })
    const body = route.request().postDataJSON()
    posts.push(body)
    const total = body.query === "ops" ? 2 : 0
    const current = body.action === "previous" ? 1 : body.action === "next" ? 2 : total ? 1 : 0
    return route.fulfill({ json: { state: "ok", current, total } })
  })
  return posts
}
try {
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    await setup(page, false)
    await page.goto(`${preview.origin}/?surface=ops`, { waitUntil: "domcontentloaded", timeout: 300_000 })
    await expect(page.locator(".surface-head h2")).toBeVisible({ timeout: 120_000 })
    await page.waitForTimeout(500)
    const prevented = await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true })
      document.body.dispatchEvent(event)
      return event.defaultPrevented
    })
    if (prevented) throw new Error("the reader prevented the browser's own find")
    await expect(page.locator(".surface-find")).toHaveCount(0)
    results.push("PASS plain browser: Cmd/Ctrl+F stays the browser's native find")
    await page.close()
  }
  for (const dir of ["ltr", "rtl"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } })
    const posts = await setup(page, true)
    await page.goto(`${preview.origin}/?surface=ops`, { waitUntil: "domcontentloaded", timeout: 300_000 })
    await page.evaluate((value) => { document.documentElement.dir = value }, dir)
    const close = page.getByRole("button", { name: /Close/ }).first()
    await expect(close).toBeVisible({ timeout: 120_000 })
    await close.focus()
    await page.keyboard.press("Control+f")
    const input = page.getByRole("searchbox", { name: "Find in Surface" })
    await expect(input).toBeFocused()
    await input.fill("ops")
    const count = page.locator(".surface-find-count")
    await expect(count).toHaveText("1 of 2")
    await input.press("Enter")
    await expect(count).toHaveText("2 of 2")
    await input.press("Shift+Enter")
    await expect(count).toHaveText("1 of 2")
    await input.fill("none")
    await expect(count).toHaveText("No matches")
    const fits = await page.evaluate(() => {
      const head = document.querySelector(".surface-head")
      const inside = (el) => { const a = el.getBoundingClientRect(), b = document.documentElement.getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1 }
      return [...document.querySelectorAll(".surface-find > *, .surface-head-actions > *")].every(inside) && head.scrollWidth <= head.clientWidth + 1
    })
    if (!fits) throw new Error(`${dir}: the find bar or the reader actions overflow at 390 px`)
    await page.screenshot({ path: `/tmp/surface-find-390-${dir}.png` })
    await input.press("Escape")
    await expect(page.locator(".surface-find")).toHaveCount(0)
    await expect(close).toBeFocused()
    await expect(page.locator(".desk-surface")).toHaveCount(1)
    if (!posts.some((body) => body.action === "clear")) throw new Error("closing did not clear the highlights")
    if (posts.some((body) => body.frame !== "/__cap/surface/ops/m1-0123456789abcdef0123456789abcdef/")) throw new Error("find named another frame")
    results.push(`PASS ${dir} 390 px: bar opens focused, counts, next/previous, no matches, fits, Esc closes with focus returned`)
    await page.close()
  }
} catch (error) {
  process.exitCode = 1
  results.push(`FAIL ${String(error).split("\n")[0]}`)
} finally {
  console.log(results.join("\n"))
  await browser.close()
  await preview.close()
}

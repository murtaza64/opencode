// The Work Front Desk is shown as Porter wherever the person meets it: the left nav entry, its busy dot, the chat
// pane's accessible name and close control, and the remote-home host chip. LTR and RTL. Internal ids are unchanged
// (data-nav="front-desk"). Disposable fixture only. Run from packages/es-app: node test/desk-porter.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
try {
  for (const dir of ["ltr", "rtl"]) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
    await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.route("**/es/api/personas", (route) => route.fulfill({ json: { personas: [{ name: "Porter", owner_lane: "mini:opencode/front-desk", avatar_url: "https://example.invalid/porter.png" }] } }))
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
    await expect(page.locator(".desk-companion .desk-chat textarea")).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('[data-nav="front-desk"] img.nav-avatar')).toHaveAttribute("src", "https://example.invalid/porter.png")
    await expect(page.locator(".desk-companion img.desk-header-avatar")).toHaveAttribute("src", "https://example.invalid/porter.png")
    const replies = page.locator(".desk-companion img.desk-reply-avatar")
    await expect(replies.first()).toHaveAttribute("alt", "Porter")
    // An ordinary session's replies carry no Porter avatar.
    await page.goto(`${preview.url}/session/ses_b?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded" })
    await expect(page.locator(".session-page").first().locator(".transcript")).toBeVisible({ timeout: 60_000 })
    await expect(page.locator(".session-page").first().locator("img.desk-reply-avatar")).toHaveCount(0)
    await page.goto(preview.url, { waitUntil: "domcontentloaded" })
    await expect(page.locator(".desk-companion .desk-chat textarea")).toBeVisible({ timeout: 60_000 })
    if (dir === "rtl") await page.evaluate(() => { document.documentElement.dir = "rtl" })
    const entry = page.locator('[data-nav="front-desk"]')
    await expect(entry).toHaveAttribute("aria-label", "Porter (Front desk)")
    await expect(entry.locator(".nav-title")).toHaveText("Porter")
    await expect(page.getByRole("complementary", { name: "Porter (Front desk)" })).toBeAttached()
    await expect(page.locator(".desk-companion").getByRole("button", { name: "Close Porter" })).toBeVisible()
    await expect(page.getByText(/Front desk chat/)).toHaveCount(0)
    await context.close()
    console.log(`${dir}: nav entry, chat pane and close control say Porter`)
  }
  // A Personal profile's desk keeps the generic name.
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.route("**/es/api/personas", (route) => route.fulfill({ json: { personas: [{ name: "Porter", owner_lane: "x", avatar_url: "https://example.invalid/porter.png" }] } }))
  await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "excalibur", label: "Excalibur", remote: false, hosts: [], work: [], profile: "personal" } }))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.locator(".desk-companion .desk-chat textarea")).toBeVisible({ timeout: 90_000 })
  const entry = page.locator('[data-nav="front-desk"]')
  await expect(entry).toHaveAttribute("aria-label", "Front desk")
  await expect(entry.locator(".nav-title")).toHaveText("Front desk")
  await expect(page.locator(".desk-companion").getByRole("button", { name: "Close Front desk" })).toBeVisible()
  await expect(page.getByText("Porter")).toHaveCount(0)
  await expect(entry.locator("img.nav-avatar")).toHaveCount(0)
  await expect(page.locator(".desk-companion img.desk-header-avatar, .desk-companion img.desk-reply-avatar")).toHaveCount(0)
  await context.close()
  console.log("personal: the desk stays Front desk, no Porter")
  console.log("PASS desk-porter")
} catch (error) {
  console.error("FAIL desk-porter", error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close?.()
  process.exit(process.exitCode ?? 0)
}

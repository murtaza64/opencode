// Earlier Front Desk conversations stay one tap away without a list at the top of the chat: a quiet header control,
// shown only when there are earlier desks, collapsed by default, opening a list of links.
// Disposable fixture only. Run from packages/es-app: node test/desk-earlier.browser.mjs [--shot <dir> --label <name>]
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const arg = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const shots = arg("--shot"), label = arg("--label") ?? "after", check = !process.argv.includes("--shot-only")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const open = async (pointer, width = 1500) => {
  preview.fixture.pointer = pointer
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark" })
  await context.addInitScript((value) => { if (window === window.top) { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)); localStorage.setItem("es-app:front-desk:shared-seen:1", JSON.stringify("ses_a")) } }, { session: "ses_a", directory })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.locator(".desk-companion .desk-chat textarea")).toBeVisible({ timeout: 90_000 })
  return { page, close: () => context.close() }
}
try {
  const one = await open({ home: true, revision: 2, session: "ses_a", directory, predecessors: [{ session: "ses_b", directory, until: Date.now() - 3_600_000 }] })
  const chat = one.page.locator(".desk-companion")
  if (shots) await chat.screenshot({ path: path.join(shots, `${label}-closed.png`) })
  if (check) {
    // Nothing above the conversation; one quiet header control, closed.
    await expect(chat.locator(".desk-earlier")).toHaveCount(0)
    const control = chat.getByRole("button", { name: "Earlier desks (1)" })
    await expect(control).toHaveAttribute("aria-expanded", "false")
    await control.click()
    await expect(chat.getByRole("link", { name: "ses_b" })).toBeVisible()
    if (shots) await chat.screenshot({ path: path.join(shots, `${label}-open.png`) })
    await one.page.keyboard.press("Escape")
    await expect(chat.getByRole("link", { name: "ses_b" })).toBeHidden()
    await expect(control).toBeFocused()
  }
  await one.close()
  if (check) {
    const none = await open({ home: true, revision: 1, session: "ses_a", directory, predecessors: [] })
    await expect(none.page.locator(".desk-companion").getByRole("button", { name: /^Earlier desks/ })).toHaveCount(0)
    await none.close()
  }
  console.log("PASS desk-earlier")
} catch (error) {
  console.error("FAIL desk-earlier", error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close?.()
  process.exit(process.exitCode ?? 0)
}

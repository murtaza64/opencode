// The Front Desk conversation offers no Fork, Archive or Delete; an ordinary session keeps all three. The desk is
// known by its pointer (ses_a here), not its title, in both the full session page and the desk chat pane.
// (Another host's session, such as a remote-home desk, shows none of the three already: work-host-session.)
// Disposable fixture only. Run from packages/es-app: node test/desk-no-destructive.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
await context.addInitScript((value) => { if (window === window.top) localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)) }, { session: "ses_a", directory })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const main = () => page.locator(".session-page").first()
const actions = (scope) => Promise.all(["Fork this session", "Archive this session", "Delete this session"].map((title) => scope.locator(`[title="${title}"]`).count()))
try {
  await page.goto(`${preview.url}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(page.locator(".prompt-box").first()).toBeVisible({ timeout: 90_000 })
  // Wait for the ordinary composer actions so an absent Fork is not just an unrendered bar.
  await expect(page.locator('[title="Stop session"], [title="Scroll to the latest message"]').first()).toBeAttached()
  expect(await actions(page), "desk session (page and chat pane): no Fork/Archive/Delete").toEqual([0, 0, 0])

  await page.goto(`${preview.url}/session/ses_b?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await expect(main().locator('[title="Fork this session"]')).toBeAttached({ timeout: 90_000 })
  expect(await actions(main()), "ordinary session: all three").toEqual([1, 1, 1])
  expect(errors, errors.join("\n")).toEqual([])
  console.log("PASS desk-no-destructive")
} catch (error) {
  console.error("FAIL desk-no-destructive", error)
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close?.()
  process.exit(process.exitCode ?? 0)
}

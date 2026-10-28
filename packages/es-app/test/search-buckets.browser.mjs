// Sidebar search order (dotfiles#240): Pinned stays visible for any query, in its own order, even when a pin
// does not match; title matches always come before transcript-only hits, including hits that arrive later
// and a second (paged / all-time) transcript reply. Disposable fixture; no writes.
// Run from packages/es-app: node test/search-buckets.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const now = Date.now()
preview.fixture.workspaceSessions.push({ ...session("ses_ledger"), title: "Ledger migration", time: { created: 1, updated: now - 300_000 } })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
await page.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
// Pin "Other session" (does not match "ledger").
await page.addInitScript(dir => localStorage.setItem("es-app-sidebar-pins", JSON.stringify([JSON.stringify([dir, "ses_b"])])), directory)
const replies = []
await page.route("**/es/api/search?*", route => replies.push(route))
const hit = (id, title, updated) => ({ id, title, directory, parent_id: null, updated, snippet: "…ledger…", matches: 2 })
const input = page.locator(".sidebar .search-input")
const results = () => page.locator(".sidebar [role=tabpanel]").evaluate(panel => {
  const heading = [...panel.querySelectorAll(".nav-heading")].find(el => el.textContent.startsWith("results"))
  const names = []
  for (let el = heading?.nextElementSibling; el; el = el.nextElementSibling) { const title = el.querySelector(".nav-title"); if (title) names.push(title.textContent) }
  return names
})
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const pinned = page.locator(".sidebar .pinned-section")
  await expect(pinned.locator(".nav-title")).toHaveText(["Other session"], { timeout: 120_000 })
  await input.fill("ledger")
  // A non-matching pin stays in Pinned while searching.
  await expect(pinned.locator(".nav-title")).toHaveText(["Other session"])
  await expect.poll(results).toEqual(["Ledger migration"])
  // A newer transcript-only hit arrives late: it sorts after the older title match.
  await expect.poll(() => replies.length).toBe(1)
  await replies.shift().fulfill({ json: { results: [hit("ses_a", "Composer fixture", now)] } })
  await expect.poll(results).toEqual(["Ledger migration", "Composer fixture"])
  // A second (all-time) reply repeats the title match and hits the pinned session: order holds, no duplicate.
  await page.locator(".sidebar .archived-toggle", { hasText: "all time" }).click()
  await expect.poll(() => replies.length).toBe(1)
  await replies.shift().fulfill({ json: { results: [hit("ses_b", "Other session", now + 1000), hit("ses_ledger", "Ledger migration", now - 300_000)] } })
  // The pinned session is a transcript hit too; it stays in Pinned and is not repeated.
  await expect.poll(results).toEqual(["Ledger migration", "Composer fixture"])
  await expect(pinned.locator(".nav-title")).toHaveText(["Other session"])
  // Clearing restores the list; Pinned unchanged.
  await input.press("Escape")
  await expect(pinned.locator(".nav-title")).toHaveText(["Other session"])
  console.log("PASS search buckets: non-matching pin stays in Pinned; title matches above transcript-only hits across a late reply and an all-time reply; no duplicates")
} finally {
  await browser.close()
  await preview.close()
}

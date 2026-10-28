// Work view search (dotfiles#240): the sidebar's search filters Local and Mac Mini rows alike. A query
// keeps matching Mini rows and drops the rest, case-insensitively; the same session ID on both hosts stays
// two rows; a Mini that stops answering keeps its last-known rows, which filter too; pinned rows match;
// clearing restores the full list; a new Mini session matches without retyping; results sort pinned, then
// working, then most recent; pins and Mini row links keep their host identity.
// Disposable fixture; no writes. Run from packages/es-app: node test/work-search.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage()
const mini = "http://127.0.0.1:65001"
const miniRoot = "/Users/mini/fixture"
const now = Date.now()
const miniSessions = [
  { id: "ses_a", title: "Composer copy on the Mini", directory: miniRoot, time: { created: 1, updated: now - 5_000 } },
  { id: "ses_ledger", title: "Ledger migration", directory: miniRoot, time: { created: 1, updated: now - 1_000 } },
  { id: "ses_pinned", title: "Pinned scoring work", directory: miniRoot, time: { created: 1, updated: now - 50_000 } },
]
let miniDown = false
const hostWrites = []
await page.route("**/__es/host", route => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url },
  { id: "mini", label: "Mac Mini", origin: mini, default: true },
] } }))
await page.route("**/hosts/mini/**", route => {
  if (!["GET", "HEAD"].includes(route.request().method())) hostWrites.push(route.request().url())
  if (miniDown) return route.abort("connectionrefused")
  const url = new URL(route.request().url())
  if (url.pathname === "/hosts/mini/oc/experimental/session") return route.fulfill({ json: miniSessions })
  if (url.pathname === "/hosts/mini/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniRoot}/.editspace` }], default: "fixture" } })
  if (url.pathname === "/hosts/mini/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false } })
  return route.fulfill({ status: 403, body: "not exposed" })
})
await page.route("**/es/api/search?*", route => route.fulfill({ json: { results: [] } }))
await page.route(`${mini}/**`, route => route.fulfill({ contentType: "text/html", body: "<title>Mini listener</title>" }))
await page.addInitScript(root => localStorage.setItem("host:mini:es-app-sidebar-pins", JSON.stringify([JSON.stringify([root, "ses_pinned"])])), miniRoot)
// Make the Mini feed read its list again (a project scope change rereads every host), keeping the query.
const reread = async () => {
  await page.locator(".es-switcher").selectOption("__all__")
  await page.locator(".es-switcher").selectOption("fixture")
}
const input = page.locator(".sidebar .search-input")
const titles = () => page.locator(".sidebar .search-box ~ .session-entry .nav-title, .sidebar .search-box ~ .search-result .nav-title").allTextContents()
const miniRow = name => page.getByRole("link", { name: new RegExp(`^${name}, on Mac Mini(, unavailable)?$`) })
try {
  await page.goto(preview.url)
  await expect(miniRow("Ledger migration")).toBeVisible({ timeout: 90_000 })
  const before = await titles()

  // A query matching a Mini row keeps it and drops non-matching rows from both hosts; case does not matter.
  await input.fill("LEDGER")
  await expect(miniRow("Ledger migration")).toBeVisible()
  await expect(page.locator(".sidebar .nav-heading", { hasText: /^results/ })).toHaveText("results (1)")
  await expect(miniRow("Composer copy on the Mini")).toHaveCount(0)
  await expect(page.locator(".sidebar .search-result", { hasText: "Composer fixture" })).toHaveCount(0)
  // The Mini row still opens on the Mini's own listener.
  await expect(miniRow("Ledger migration")).toHaveAttribute("href", `/session/ses_ledger?directory=${encodeURIComponent(miniRoot)}&host=mini`)

  // Same ID on both hosts: one query matching both keeps two rows, each with its own host.
  await input.fill("composer")
  await expect(page.locator(".sidebar .search-result", { hasText: "Composer fixture" })).toHaveCount(1)
  await expect(miniRow("Composer copy on the Mini")).toHaveCount(1)
  await expect(page.locator(".sidebar [data-host-key='mini:ses_a']")).toHaveCount(1)

  // A pinned Mini row matches too, keeps its pin, and sorts first.
  await input.fill("o")
  await expect(miniRow("Pinned scoring work")).toBeVisible()
  await expect(page.getByRole("button", { name: "Unpin Pinned scoring work on Mac Mini" })).toBeVisible()
  const order = await page.locator(".sidebar .nav-heading", { hasText: /^results/ }).evaluate(heading => {
    const names = []
    for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
      const title = el.querySelector(".nav-title")
      if (title) names.push(title.textContent)
    }
    return names
  })
  expect(order[0], `pinned first: ${JSON.stringify(order)}`).toBe("Pinned scoring work")

  // Clearing restores the full list, in its original order.
  await input.press("Escape")
  await expect(page.locator(".sidebar .nav-heading", { hasText: /^results/ })).toHaveCount(0)
  expect(await titles()).toEqual(before)

  // A Mini session that appears on the next list read is searchable like the rest (a scope change clears the query).
  miniSessions.push({ id: "ses_ledger2", title: "Ledger backfill", directory: miniRoot, time: { created: 1, updated: now } })
  await reread()
  await expect(miniRow("Ledger backfill")).toBeVisible({ timeout: 15_000 })
  await input.fill("ledger")
  await expect(page.locator(".sidebar .nav-heading", { hasText: /^results/ })).toHaveText("results (2)")
  await expect(miniRow("Ledger backfill")).toBeVisible()
  await expect(miniRow("Pinned scoring work")).toHaveCount(0)

  // A Mini that stops answering keeps its last-known rows, dimmed, and they still filter.
  await input.fill("")
  miniDown = true
  await reread()
  await expect(page.locator(".host-status", { hasText: "Mac Mini" })).toContainText(/unreachable since/, { timeout: 30_000 })
  await expect(miniRow("Ledger migration")).toHaveAttribute("aria-disabled", "true")
  await input.fill("migration")
  await expect(miniRow("Ledger migration")).toBeVisible()
  await expect(miniRow("Ledger migration")).toHaveAttribute("aria-disabled", "true")
  await expect(miniRow("Pinned scoring work")).toHaveCount(0)

  expect(hostWrites).toEqual([])
  expect(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS work search: Mini rows filter with Local (case-insensitive), same id kept apart, pinned first, clear restores, new Mini row searchable, last-known rows filter; zero writes")
} finally {
  await browser.close()
  await preview.close()
}

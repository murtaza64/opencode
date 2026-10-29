// Front desk failure rows: age from the failure record, and a persistent per-failure Ignore (dotfiles#247).
// Run from packages/es-app: node test/failure-ignore.browser.mjs
import { needsCount, needsRow, overview } from "./desk-lists.mjs"
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const now = Date.now()
const base = { projectID: "fixture", version: "1", agent: "build" }
preview.fixture.workspaceSessions = [
  { ...base, id: "ses_old", title: "Legacy importer cleanup", directory, time: { created: now - 9 * 86400_000, updated: now - 3 * 86400_000 } },
  { ...base, id: "ses_new", title: "Sidebar density pass", directory, time: { created: now - 3600_000, updated: now - 600_000 } },
]
const oldFailure = { sessionID: "ses_old", directory, messageID: "msg_old", parentID: "msg_u2", time: now - 3 * 86400_000 - 5 * 3600_000, error: { name: "ProviderAuthError" }, retry: "unsafe" }
const newFailure = { sessionID: "ses_new", directory, messageID: "msg_new", parentID: "msg_u1", time: now - 12 * 60_000, error: { name: "APIError", statusCode: 529 }, retry: "available" }
preview.fixture.failures = [newFailure, oldFailure]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const row = title => needsRow(page, title)
const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click()
const count = (n) => expect(needsCount(page)).toHaveText(String(n))
try {
  await page.goto(preview.url)
  await count(5)
  // The row reports when the step failed (its error label is the tooltip); an old one is dimmed.
  await expect(row("Legacy importer cleanup")).toContainText("3d ago")
  await expect(row("Legacy importer cleanup").locator(".session-project")).toHaveAttribute("title", "Provider authentication failed")
  await expect(row("Legacy importer cleanup")).toHaveClass(/nav-old/)
  await expect(row("Sidebar density pass")).toContainText("12m ago")
  await expect(row("Sidebar density pass").locator(".session-project")).toHaveAttribute("title", "Provider error 529 (overloaded)")
  await expect(row("Sidebar density pass")).not.toHaveClass(/nav-old/)

  await row("Legacy importer cleanup").click()
  const card = page.locator(".desk-failure")
  await expect(card.locator("h3")).toHaveText("Legacy importer cleanup")
  await expect(card.locator(".home-source").first()).toContainText("Provider authentication failed · ")
  await expect(card.locator(".home-source").first()).toContainText("(3d ago)")
  // Retry is offered only when the failure can be retried.
  await expect(card.locator("button", { hasText: "Retry" })).toHaveCount(0)
  await expect(card.locator("summary")).toHaveText("Error details")
  await card.getByRole("button", { name: "Ignore", exact: true }).click()

  await count(4)
  await expect(row("Legacy importer cleanup")).toHaveCount(0)
  await expect(row("Sidebar density pass")).toHaveCount(1)
  expect(preview.ledger.ignoreCalls).toEqual([expect.objectContaining({ op: "ignore", sessionID: "ses_old", messageID: "msg_old", failedAt: oldFailure.time })])
  // The thread itself is untouched: nothing was written to that session.
  expect(preview.fixture.calls.filter(call => call.method !== "GET" && call.path.includes("ses_old"))).toEqual([])

  await refresh()
  await page.reload()
  await count(4)
  await expect(row("Legacy importer cleanup")).toHaveCount(0)

  const inbox = await overview(page)
  await inbox.locator(".desk-history summary").click()
  await expect(inbox.locator(".desk-history summary")).toContainText("Ignored 1")
  await expect(inbox.getByRole("button", { name: /^Answered/ })).toBeVisible()
  await inbox.getByRole("button", { name: /^Ignored/ }).click()
  await expect(inbox.getByRole("list", { name: "Ignored failures" })).toContainText("Legacy importer cleanup")

  // A new failure in the same session is a different identity and shows again.
  preview.fixture.failures = [newFailure, { ...oldFailure, messageID: "msg_old2", time: Date.now() - 60_000 }]
  await refresh()
  await count(5)
  await expect(row("Legacy importer cleanup")).toContainText("1m ago")
  await row("Sidebar density pass").click()
  await expect(page.locator(".desk-failure button", { hasText: "Retry" })).toHaveClass(/home-primary/)

  // Unignore restores the original identity.
  preview.fixture.failures = [newFailure, oldFailure]
  await refresh()
  await count(4)
  await (await overview(page)).getByRole("list", { name: "Ignored failures" }).getByRole("button", { name: "Unignore" }).click()
  await count(5)
  console.log("failure-ignore.browser: ok")
} finally {
  await browser.close()
  await preview.close()
}

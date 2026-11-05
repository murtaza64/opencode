// Needs-you count lives in the unified list's Needs you heading (the legacy Decisions & inbox nav row and
// its badge are gone). The count follows pending permissions and the desk's unanswered items.
// Disposable in-memory fixture only. Run from packages/es-app: node test/mode-badge.browser.mjs
import { needsCount, needsRow } from "./desk-lists.mjs"
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const fixture = preview.fixture
const now = Date.now()
fixture.workspaceSessions = [{ projectID: "fixture", version: "1", agent: "build", id: "ses_fail", title: "Importer cleanup", directory, time: { created: now - 3600_000, updated: now - 600_000 } }]
fixture.failures = [{ sessionID: "ses_fail", directory, messageID: "msg_fail", parentID: "msg_user", time: now - 600_000, error: { name: "APIError", statusCode: 529 }, retry: "available" }]
fixture.permissions = []
const permission = { id: "per_new", sessionID: "ses_b", permission: "bash", patterns: ["bun test"], always: ["bun *"], metadata: { command: "bun test", description: "Synthetic per_new" } }
const emit = (type, properties) => {
  for (const [response, stream] of fixture.eventStreams) if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
}
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const nav = page.getByRole("navigation", { name: "Main" })
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(nav).toBeVisible({ timeout: 90_000 })
  // No legacy nav row and no badge on the quick row.
  await expect(nav.getByRole("link", { name: /Decisions & inbox/ })).toHaveCount(0)
  await expect(nav.locator(".nav-count")).toHaveCount(0)
  await expect(needsCount(page)).toHaveText("3")
  // A new pending permission is counted once it is confirmed pending.
  fixture.permissions = [permission]
  emit("permission.asked", permission)
  await expect(needsCount(page)).toHaveText("4")
  // Handled elsewhere: the reply event removes it.
  fixture.permissions = []
  emit("permission.replied", { sessionID: "ses_b", requestID: "per_new", reply: "once" })
  await expect(needsCount(page)).toHaveText("3")
  // Ignored on the desk: the count drops.
  await page.goto(`${preview.url}/`, { waitUntil: "domcontentloaded" })
  await needsRow(page, "Importer cleanup").click()
  await page.locator(".desk-failure").getByRole("button", { name: "Ignore", exact: true }).click()
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded" })
  await expect(needsCount(page)).toHaveText("2")
  expect(errors).toEqual([])
  console.log("mode-badge: PASS (Needs you count only; legacy nav row and badge gone)")
} finally {
  await browser.close()
  await preview.close()
}

// Decisions & inbox nav entry: an unread-style count of actionable Needs-you items, the same on every view.
// Disposable in-memory fixture only. Run from packages/es-app: node test/mode-badge.browser.mjs
import { needsCount, needsRow, needsYou, overview } from "./desk-lists.mjs"
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
const modes = page.getByRole("navigation", { name: "Main" })
const deskTab = modes.getByRole("link", { name: /^Decisions & inbox/ })
const badge = deskTab.locator(".nav-count")
const toAgents = () => modes.getByRole("link", { name: "Agent map" }).click()
const needs = (title) => needsRow(page, title)
// Refresh sits in the overview, or beside Close when an item is open.
const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click()
const expectCount = async (count) => {
  await expect(badge).toHaveText(String(count))
  await expect(deskTab).toHaveAttribute("aria-label", `Decisions & inbox, ${count} need${count === 1 ? "s" : ""} you`)
}
try {
  // Two open decisions (fixture and other project) and one failure.
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(modes).toBeVisible({ timeout: 90_000 })
  await expectCount(3)
  // Measure once layout has settled (late web fonts shift the row); a font swap is not the count changing.
  let box
  await expect.poll(async () => { const previous = box; await page.waitForTimeout(250); box = await badge.boundingBox(); return previous?.y === box?.y }, { timeout: 10_000 }).toBe(true)

  // A new pending permission is counted once it is confirmed pending.
  fixture.permissions = [permission]
  emit("permission.asked", permission)
  await expectCount(4)
  // The badge sits out of flow: a wider number does not move it or the tab label.
  expect(await badge.boundingBox()).toMatchObject({ y: box.y })

  // The badge is exactly the desk's Needs-you count, and an offline ledger keeps its last-known
  // decisions instead of dropping the count.
  preview.ledger.status = 503
  await deskTab.click()
  await expectCount(4)
  const inbox = await overview(page)
  await inbox.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(inbox.locator(".desk-source:not([data-state=current])", { hasText: "Attention ledger" })).toBeVisible()
  await expect(needsCount(page)).toHaveText("4")
  await toAgents()
  await expectCount(4)
  preview.ledger.status = 200

  // Handled elsewhere: the reply event removes it.
  fixture.permissions = []
  emit("permission.replied", { sessionID: "ses_b", requestID: "per_new", reply: "once" })
  await expectCount(3)

  // Ignored on the desk: the count drops when switching back to Agents.
  await deskTab.click()
  await needs("Importer cleanup").click()
  await page.locator(".desk-failure").getByRole("button", { name: "Ignore", exact: true }).click()
  await expect(needs("Importer cleanup")).toHaveCount(0)
  await toAgents()
  await expectCount(2)

  // Answered elsewhere: the next ledger read drops it; one item reads in the singular.
  preview.ledger.records.find((record) => record.id === "other_decision").status = "answered"
  await deskTab.click()
  await refresh()
  await expect(needs("Other project decision")).toHaveCount(0)
  await toAgents()
  await expectCount(1)

  // Nothing waiting: no badge, and the tab name has no count.
  preview.ledger.records.find((record) => record.id === "decision_1").status = "answered"
  await deskTab.click()
  await refresh()
  await expect(needsYou(page)).toHaveCount(0)
  await toAgents()
  await expect(badge).toHaveCount(0)
  await expect(deskTab).not.toHaveAttribute("aria-label", /need/)

  // The collapsed rail carries the same count.
  preview.ledger.records.find((record) => record.id === "decision_1").status = "open"
  await deskTab.click()
  await refresh()
  await toAgents()
  await expectCount(1)
  await page.getByRole("button", { name: "Collapse sidebar" }).click()
  await expect(modes.getByRole("link", { name: "Decisions & inbox, 1 needs you" })).toBeVisible()
  await expect(modes.locator(".nav-count")).toHaveText("1")

  expect(errors).toEqual([])
  console.log("mode-badge: PASS")
} finally {
  await browser.close()
  await preview.close()
}

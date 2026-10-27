// Answered decisions are not outcomes: until the agent resolves the record, the Front Desk lists it under
// "Waiting on agents", oldest first, and marks answers left unresolved for hours as stalled. Blocked
// deliveries stay in History (already flagged there); resolved records never show. Disposable fixture.
// Run from packages/es-app: node test/desk-waiting.browser.mjs
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const now = Date.now()
const preview = await startAttentionPreview()
preview.fixture.editspaces = [{ name: "fixture", root: directory }]
const base = preview.ledger.records[0]
const answered = (id, title, hoursAgo, delivery, status = "answered") => ({
  ...base, id, title, status, gate_key: `fixture:${id}:v1`, revision: 2,
  answer: { id: `answer-${id}`, text: "", choice_id: "small", answered_at: now - hoursAgo * 3600_000, revision: 1 },
  delivery_state: delivery, delivery: { state: delivery, reason: delivery === "blocked" ? "owner-unverified" : null, copies: [] },
})
preview.ledger.records.push(
  answered("signer", "Firefox SSO update needs a Mozilla signer", 16, "handled"),
  answered("palette", "Pick the palette direction", 3, "presented"),
  answered("blocked", "Blocked answer", 2, "blocked"),
  answered("done", "Resolved answer", 30, "handled", "resolved"),
)
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => { try { localStorage.setItem("es-app-all-projects", "true") } catch {} })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on("pageerror", error => errors.push(error.message))
  page.setDefaultNavigationTimeout(300_000)
  page.setDefaultTimeout(60_000)
  await page.goto(preview.url)
  const waiting = page.locator(".desk-waiting")
  await expect(waiting.locator("summary")).toHaveText("Waiting on agents 2 · 1 stalled")
  // Folded by default, so the decision queue keeps its space.
  await expect(waiting.locator("[data-desk-waiting]").first()).toBeHidden()
  await waiting.locator("summary").click()
  const rows = waiting.locator("[data-desk-waiting]")
  await expect(rows).toHaveCount(2)
  assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.getAttribute("data-desk-waiting"))),
    ["attention:fixture:signer", "attention:fixture:palette"], "oldest answer first; blocked and resolved excluded")
  await expect(rows.nth(0)).toContainText("answered 16h ago · agent read it")
  await expect(rows.nth(0).locator(".home-blocked")).toHaveText("answered 16h ago")
  await expect(rows.nth(1)).toContainText("answered 3h ago · delivered")
  await expect(rows.nth(1).locator(".home-blocked")).toHaveCount(0)
  // A row opens the answered record with its answer and delivery status.
  await rows.nth(0).click()
  const card = page.locator('[data-attention-id="signer"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText("Firefox SSO update needs a Mozilla signer")
  // History is unchanged: the same answered records stay listed there.
  // A blocked delivery already opens History by itself.
  await expect(page.locator(".desk-history")).toHaveAttribute("open", "")
  await expect(page.locator(".desk-history .desk-item", { hasText: "Firefox SSO update needs a Mozilla signer" })).toBeVisible()
  assert.deepEqual(errors, [])
  console.log("PASS desk waiting-on-agents")
} finally {
  await browser.close()
  await preview.close()
}

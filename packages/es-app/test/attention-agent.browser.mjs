import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const { fixture } = preview
const now = Date.now()
fixture.sessionIDs = ["ses_a", "ses_b", "ses_c"]
fixture.sessionTitles.set("ses_a", "Joiner").set("ses_b", "Tether").set("ses_c", "Relay (2)")
fixture.workspaceSessions = [{ ...session("ses_old"), title: "Relay", time: { created: 1, updated: 2 } }]
fixture.laneOwners = [{ lane: "batch-orchestrator", owner: "ses_a" }, { lane: "squadron-v2", owner: "ses_b" }, { lane: "orchestrator", owner: "ses_c" }]
fixture.handoffs = [{ lane: "orchestrator", predecessor: "ses_old", successor: "ses_c" }]
fixture.permissions = []
const decision = (id, title, origin, lane, extra = {}) => ({ id, editspace: "fixture", revision: 1, status: "open", kind: "decision", title, lane,
  context: "Synthetic request.", options: [{ id: "go", label: "Go" }], producer_session: origin, origin_session: origin, gate_key: `gate:${id}`,
  source_ref: { session_id: origin, directory }, decision: null, delivery_state: "not-requested", created_at: now, updated_at: now, ...extra })
preview.ledger.records = [
  decision("joiner_1", "Pick a worker for the bridge", "ses_a", "batch-orchestrator"),
  decision("tether_1", "Approve the squadron layout", "ses_b", "squadron-v2"),
  decision("legacy_1", "Legacy request without an identity", "ses_gone", null),
  decision("relay_1", "Confirm the release window", "ses_old", "orchestrator", { producer_session: "ses_c" }),
]
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
try {
  for (const rtl of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    if (rtl) await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    const page = await context.newPage()
    page.on("pageerror", error => errors.push(error.message))
    const queue = page.getByRole("complementary", { name: "Decisions and inbox" })
    const row = title => queue.locator(".desk-item").filter({ hasText: title })
    // A fresh preview optimizes dependencies on first load; allow for a cold start.
    await page.goto(preview.url, { timeout: 120_000 })

    // Agents sharing one project are told apart; the project stays secondary.
    await expect(row("Pick a worker").locator(".desk-item-agent")).toHaveText("Joiner")
    await expect(row("Pick a worker").locator(".home-source")).toContainText("decision · Joiner · fixture")
    await expect(row("Approve the squadron").locator(".desk-item-agent")).toHaveText("Tether")
    await expect(row("Approve the squadron").locator(".desk-item-agent")).toHaveAttribute("title", "ses_b")
    // Unknown identity: an explicit fallback, raw id only in the tooltip.
    await expect(row("Legacy request").locator(".desk-item-agent")).toHaveText("Unknown agent")
    await expect(row("Legacy request").locator(".desk-item-agent")).toHaveAttribute("title", "ses_gone")
    // A handed-off requester is still the requester in the queue.
    await expect(row("Confirm the release").locator(".desk-item-agent")).toHaveText("Relay")

    // The selected header links the agent's conversation and names project second.
    await row("Pick a worker").click()
    const header = page.locator('[data-attention-id="joiner_1"] .home-eyebrow')
    await expect(header.locator(".attention-agent")).toHaveText("Joiner")
    await expect(header.locator("a.attention-agent")).toHaveAttribute("href", `/session/ses_a?directory=${encodeURIComponent(directory)}`)
    await expect(header.locator(".attention-project")).toHaveText(" · fixture")
    await expect(header.locator(".attention-routing")).toHaveCount(0)

    // Requester versus current destination is spelled out only when they differ.
    await row("Confirm the release").click()
    const relay = page.locator('[data-attention-id="relay_1"] .home-eyebrow')
    await expect(relay.locator(".attention-agent")).toHaveText("Relay")
    await expect(relay.locator(".attention-routing")).toContainText("Updated by Relay (2)")
    await expect(relay.locator(".attention-routing")).toContainText("Handed off · answers go to Relay (2)")
    await expect(relay.locator('.attention-routing a[data-agent-session="ses_c"]').first()).toHaveAttribute("href", /\/session\/ses_c\?/)

    // No per-row runtime lookups: names come from already loaded session data.
    const sessionReads = fixture.calls.filter(call => /^\/session\/ses_(a|b|c|old|gone)$/.test(call.path)).length
    await row("Approve the squadron").click()
    await row("Legacy request").click()
    expect(fixture.calls.filter(call => /^\/session\/ses_(a|b|c|old|gone)$/.test(call.path)).length).toBe(sessionReads)
    await context.close()
  }
  expect(errors).toEqual([])
  console.log("PASS attention agent: shared project, unknown/legacy, handed-off requester with verified destination, header link, LTR/RTL, no per-row runtime reads")
} finally {
  await browser.close()
  await preview.close()
}

// Needs you lists explicit requests only (Main1296): an open decision and a native permission appear; a finished,
// idle agent's notice never adds a row or makes the band appear. Its state stays on the agent row in Agents.
// Disposable fixture; no writes. Run from packages/es-app: node test/needs-you-explicit.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
// The finished-session notice the dashboard records on busy -> idle, for the idle "Other session" (ses_b). It is
// fresh on every read, and the Decisions tab is open, so the session row is offscreen and its notice is not
// already marked seen: before this fix that is exactly when the band added an idle row.
await page.addInitScript(() => localStorage.setItem("es-app:nav-tab", "decisions"))
await page.route("**/es/api/notifications", (route) => route.fulfill({ json: { notifications: [
  { id: "idle:ses_b", kind: "idle", session: "ses_b", title: "Other session", directory, editspace: "fixture", updated: Date.now() },
] } }))
const sidebar = page.locator("nav.sidebar")
const band = sidebar.getByRole("region", { name: "Needs you" })
try {
  // A decision and a permission: exactly those explicit requests, no idle row.
  preview.ledger.records = preview.ledger.records.filter((record) => record.id === "decision_1")
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(band.getByText("Choose the bounded implementation scope")).toBeVisible({ timeout: 120_000 })
  // The fixture's pending bash permission (asked in ses_a's thread) is the second explicit request.
  await expect(band.locator(".nav-item[data-kind=permission]")).toHaveCount(1)
  await expect(band.locator(".nav-item")).toHaveCount(2)
  await expect(band.locator(".notification-item")).toHaveCount(0)
  await expect(band.locator(".nav-heading-count")).toHaveText("2")
  // The idle agent is still listed in Agents.
  await sidebar.getByRole("tab", { name: /^Agents/ }).click()
  await expect(sidebar.locator(".session-entry .nav-title", { hasText: "Other session" }).first()).toBeVisible()

  // Only the idle notice left: no band, no count.
  preview.ledger.records = []
  preview.fixture.permissions = []
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(sidebar.getByRole("tab", { name: /^Decisions/ })).toHaveAttribute("aria-selected", "true", { timeout: 120_000 })
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("nav.sidebar .dot").length), { timeout: 120_000 }).toBeGreaterThan(0)
  await expect(band).toHaveCount(0)
  await expect(sidebar.locator(".notification-item")).toHaveCount(0)
  expect(errors).toEqual([])
  console.log("needs-you-explicit: PASS")
} finally {
  await browser.close()
  await preview.close()
}

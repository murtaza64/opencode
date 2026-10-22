import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
fixture.laneOwners = [{ lane: "work", owner: "ses_a" }]
const edge = { lane: "work", predecessor: "ses_a", successor: "ses_b", reason: "Context rollover at 500k tokens" }
let pending = [{ ...edge, request_id: "rollover", status: "prepared", error: null }]
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext()
await context.route("**/es/api/handoffs?*", (route) => route.fulfill({ json: { handoffs: fixture.handoffs ?? [], pending } }))
const page = await context.newPage()
const href = (id) => `${preview.origin}/session/${id}?directory=${encodeURIComponent(directory)}`
const editor = (page) => page.locator(".prompt-box").getByRole("textbox", { name: "Message", exact: true })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
try {
  await page.goto(href("ses_a"))
  await expect(page.getByLabel("Handoff progress")).toContainText("Preparing the next session")
  await expect(page.getByLabel("Handoff progress")).toContainText("Context rollover at 500k tokens")
  await editor(page).fill("Keep my message through the rollover")
  fixture.superseded.set("ses_a", { successor: "ses_b" })
  await page.locator(".prompt-box").getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator(".handoff-recovery")).toContainText("still preparing")
  await expect(page.locator(".handoff-recovery").getByRole("link")).toHaveCount(0)
  await expect(editor(page)).toHaveValue("Keep my message through the rollover")

  const successor = await context.newPage()
  await successor.goto(href("ses_b"))
  await expect(successor.getByLabel("Handoff progress")).toContainText("This session is not ready yet")
  await successor.evaluate(() => { document.documentElement.dir = "rtl"; document.documentElement.lang = "ar" })
  await expect(successor.getByLabel("Handoff progress")).toBeVisible()

  pending = [{ ...pending[0], status: "submitting", error: "temporary runtime failure" }]
  fixture.emitDashboard("handoff")
  await expect(page.getByLabel("Handoff progress")).toContainText("Handoff paused")
  await expect(editor(page)).toHaveValue("Keep my message through the rollover")

  pending = []
  fixture.handoffs = [edge]
  fixture.laneOwners = [{ lane: "work", owner: "ses_b" }]
  fixture.emitDashboard("handoff")
  await expect(page.locator(".handoff-recovery").getByRole("link")).toBeVisible()
  const before = fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method)).length
  await page.locator(".handoff-recovery").getByRole("link").click()
  await expect(page).toHaveURL(href("ses_b"))
  await expect(editor(page)).toHaveValue("Keep my message through the rollover")
  await expect(page.getByLabel("Previous session")).toContainText("Context rollover at 500k tokens")
  await expect(page.getByLabel("Handoff progress")).toHaveCount(0)
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toHaveLength(before)

  fixture.handoffs = [{ ...edge, kickoff: "skipped", context: "/lanes/work/handoffs/0123456789abcdef-handoff.md" }]
  fixture.emitDashboard("handoff")
  await expect(page.getByLabel("Previous session")).toContainText("Handoff brief not sent because this session was already in use")
  await expect(page.getByLabel("Previous session")).toContainText("0123456789abcdef-handoff.md")
  expect(errors).toEqual([])
  console.log("PASS handoff progress: proactive notice, empty successor, paused transfer, context reason, skipped late kickoff and draft recovery without resend")
} finally {
  await context.close()
  await browser.close()
  await preview.close()
}

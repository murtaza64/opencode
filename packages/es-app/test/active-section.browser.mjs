// All view, Active section: running agents (busy, or waiting on a permission or question) are listed under Active,
// below Needs you and Recent, never also in Recent; the count is in the header; with agents running a long Recent
// shows its first 8 rows and "N more in Recent", so Active stays in view; the section hides when nothing runs; rows
// keep the Recent row layout. Status comes from the existing stream. LTR and RTL.
// Run from packages/es-app: node test/active-section.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const now = Date.now()
const agent = (id, title, at) => ({ id, title, directory, projectID: "fixture", slug: id, version: "1", agent: "build",
  time: { created: at, updated: at, turn: { started: at, ended: at - 1 } } })
preview.fixture.workspaceSessions.push(
  agent("ses_runner", "Running lane", now - 5 * 60_000),
  agent("ses_asker", "Waiting on a permission", now - 9 * 60_000),
  ...Array.from({ length: 12 }, (_, index) => agent(`ses_idle${index}`, `Idle agent ${index}`, now - (index + 1) * 3_600_000)),
)
preview.fixture.extraStatus = { ses_runner: { type: "busy" } }
preview.fixture.permissions = [...(preview.fixture.permissions ?? []), { id: "per_asker", sessionID: "ses_asker", permission: "bash", patterns: ["ls"], always: [], metadata: {} }]

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
await context.addInitScript(() => {
  if (sessionStorage.getItem("active-init")) return
  sessionStorage.setItem("active-init", "1")
  for (const key of ["es-app:nav-tab", "es-app:sidebar-density", "es-app:sidebar-order", "es-app:sidebar-opened:1"]) localStorage.removeItem(key)
  localStorage.setItem("es-app-all-projects", "false")
})
await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
page.setDefaultTimeout(90_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const sidebar = page.locator("nav.sidebar")
const panel = sidebar.locator("[role=tabpanel]")
const active = panel.getByRole("region", { name: /^Active/ })
const recentTitles = () => panel.locator(".recent-list:not(.active-list) .nav-title").allTextContents()
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(active).toBeVisible({ timeout: 120_000 })
  // The base fixture also has a session waiting on a permission (Other session) and a processing cloud agent.
  await expect(active.locator(".nav-heading-count")).toHaveText("4")
  await expect(active.locator(".nav-title")).toHaveText(["Running lane", "Waiting on a permission", "Other session", "cloud-review"])
  await expect(active.locator('.session-entry[data-dot="busy"]')).toHaveCount(2)
  await expect(active.locator('.session-entry[data-dot="pending"]')).toHaveCount(2)
  // Not duplicated in Recent; Recent is collapsed to 8 rows with a "more" link while agents run.
  const recent = await recentTitles()
  assert(!recent.includes("Running lane") && !recent.includes("Waiting on a permission"), `no duplicates: ${recent}`)
  assert.equal(recent.length, 8)
  await expect(panel.locator(".recent-more")).toHaveText(/^\d+ more in Recent$/)
  // Order: Needs you, Recent, Active.
  const tops = await page.evaluate(() => [".needs-you-band", ".recent-list:not(.active-list)", ".active-section"].map((selector) => document.querySelector(`nav.sidebar ${selector}`)?.getBoundingClientRect().top ?? -1))
  assert(tops[0] >= 0 && tops[0] < tops[1] && tops[1] < tops[2], `order Needs you < Recent < Active: ${tops}`)
  // Same row layout: icon slot and time column line up with Recent rows.
  const columns = await panel.evaluate((root) => [...root.querySelectorAll(".recent-list > .session-entry")].map((row) => {
    const icon = row.querySelector(".session-avatar")?.getBoundingClientRect()
    const time = row.querySelector(".row-trailing time")?.getBoundingClientRect()
    return [icon ? Math.round(icon.left) : null, time ? Math.round(time.right) : null]
  }))
  assert.equal(new Set(columns.map(([icon]) => icon).filter((value) => value !== null)).size, 1, `one icon slot ${JSON.stringify(columns)}`)
  assert.equal(new Set(columns.map(([, time]) => time).filter((value) => value !== null)).size, 1, `one time column ${JSON.stringify(columns)}`)
  if (shots) await sidebar.screenshot({ path: path.join(shots, "active-ltr.png") })

  // "more" expands Recent in place.
  await panel.locator(".recent-more").click()
  await expect.poll(async () => (await recentTitles()).length).toBeGreaterThan(8)
  await expect(panel.locator(".recent-more")).toHaveCount(0)

  // RTL mirrors.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(active).toBeVisible()
  if (shots) await sidebar.screenshot({ path: path.join(shots, "active-rtl.png") })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })

  // Focus out of the list (a focused list holds its order and offers new rows behind "N new").
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await sidebar.hover()
  await page.mouse.move(900, 600)
  // The runner finishes and the permission is answered (status stream only): Active hides, both are back in Recent.
  preview.fixture.extraStatus = {}
  preview.fixture.permissions = (preview.fixture.permissions ?? []).filter((item) => item.id !== "per_asker")
  for (const [response, stream] of preview.fixture.eventStreams) if (stream.path === "/global/event") {
    response.write(`data: ${JSON.stringify({ directory, payload: { type: "session.status", properties: { sessionID: "ses_runner", status: { type: "idle" } } } })}\n\n`)
    response.write(`data: ${JSON.stringify({ directory, payload: { type: "permission.replied", properties: { sessionID: "ses_asker", requestID: "per_asker", permissionID: "per_asker", reply: "once" } } })}\n\n`)
  }
  await expect(active.locator(".nav-heading-count")).toHaveText("2", { timeout: 60_000 })
  await expect(active.locator(".nav-title")).toHaveText(["Other session", "cloud-review"])
  await expect.poll(recentTitles, { timeout: 30_000 }).toEqual(expect.arrayContaining(["Running lane", "Waiting on a permission"]))
  assert.deepEqual(errors, [])
  // Nothing running: the section hides.
  preview.ledger.cloudLanes = preview.ledger.cloudLanes.map((lane) => ({ ...lane, "wingman-status": "completed" }))
  preview.fixture.permissions = []
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(panel.locator(".recent-list").first()).toBeVisible({ timeout: 120_000 })
  await expect(active).toHaveCount(0, { timeout: 60_000 })
  await expect(panel.locator(".recent-more")).toHaveCount(0)
  console.log("PASS active-section: running + waiting under Active with count, not in Recent, Recent collapsed to 8 + more, order, aligned columns, RTL, live leave via status stream, hides when nothing runs")
} catch (error) {
  console.error(error)
  if (shots) await page.screenshot({ path: path.join(shots, "active-failure.png") }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  await preview.close()
}

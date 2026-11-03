// sidebar-decision-history-tabs: the Decisions tab has Open | History. History lists this host's attention records that
// no longer need you (answered, blocked, not sent, snoozed, resolved, withdrawn) newest first, each with its outcome as a
// word and a glyph, who asked, and when; the tab's filter applies; opening a row shows it in its reader and writes nothing.
// The segment control works by keyboard; the selected browse tab reads as a pill. Synthetic ledger; RTL and 390.
// Run from packages/es-app: node test/decision-history.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const base = preview.ledger.records[0]
const now = Date.now()
const past = (id, minutes, fields) => ({ ...base, id, gate_key: `fixture:${id}:v1`, lane: "release", created_at: now - minutes * 60_000 - 1000, updated_at: now - minutes * 60_000, ...fields })
const answer = (choice, minutes) => ({ id: `ans_${choice}`, text: "", choice_id: choice, answered_at: now - minutes * 60_000 })
preview.ledger.records.push(
  past("h_answered", 5, { status: "answered", title: "Ship the release notes today", answer: answer("small", 5), delivery_state: "presented" }),
  past("h_blocked", 15, { status: "answered", title: "Rotate the staging keys", answer: answer("small", 15), delivery_state: "blocked" }),
  past("h_decided", 30, { status: "decided", title: "Pick the demo dataset", answer: answer("defer", 30) }),
  past("h_snoozed", 60, { status: "snoozed", title: "Review the onboarding copy", snoozed_until: now + 3_600_000 }),
  past("h_resolved", 120, { status: "resolved", title: "Merge the cache fix", answer: answer("small", 125) }),
  past("h_withdrawn", 240, { status: "withdrawn", title: "Old migration plan" }),
)
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
let failed = false
const open = async (viewport) => {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(() => { if (window === window.top) { localStorage.setItem("es-app:nav-tab", "decisions"); localStorage.setItem("es-app-all-projects", "true") } })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const writes = []
  // Any write to the attention ledger counts; the operator-session handshake (/attention/session) does not change a record.
  page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && request.url().includes("/attention") && !request.url().endsWith("/attention/session")) writes.push(request.url()) })
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  return { context, page, writes }
}
try {
  for (const [name, viewport, rtl] of [["1440", { width: 1440, height: 900 }, false], ["rtl", { width: 1440, height: 900 }, true], ["390", { width: 390, height: 844 }, false]]) {
    const { context, page, writes } = await open(viewport)
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
    const sidebar = page.locator("nav.sidebar")
    const views = sidebar.getByRole("radiogroup", { name: "Decisions view" })
    await expect(views).toBeVisible({ timeout: 120_000 })
    await expect(views.getByRole("radio", { name: /^Open/ })).toHaveAttribute("aria-checked", "true")
    // The selected browse tab is a filled pill.
    assert.notEqual(await sidebar.locator("#nav-tab-decisions").evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", `${name}: selected tab has a fill`)
    if (shots) await sidebar.screenshot({ path: path.join(shots, `${name}-open.png`) })
    // Keyboard: arrow to History.
    await views.getByRole("radio", { name: /^Open/ }).focus()
    await page.keyboard.press(rtl ? "ArrowLeft" : "ArrowRight")
    const historyRadio = views.getByRole("radio", { name: "History" })
    await expect(historyRadio).toHaveAttribute("aria-checked", "true")
    await expect(historyRadio).toBeFocused()
    const rows = sidebar.getByRole("list", { name: "Decision history" }).locator(".nav-history-row")
    await expect(rows.locator(".nav-title")).toHaveText(["Ship the release notes today", "Rotate the staging keys", "Pick the demo dataset", "Review the onboarding copy", "Merge the cache fix", "Old migration plan"])
    await expect(rows.locator(".nav-history-status")).toHaveText(["Answered", "Blocked", "Not sent", "Snoozed", "Resolved", "Withdrawn"])
    await expect(rows.nth(0).locator(".nav-history-meta")).toContainText("Small scope")
    await expect(rows.nth(0).locator(".nav-history-meta")).toContainText("release")
    // None of the open decisions is in History, and Open lists none of these.
    await expect(rows.filter({ hasText: "Choose the bounded implementation scope" })).toHaveCount(0)
    if (shots) await sidebar.screenshot({ path: path.join(shots, `${name}-history.png`) })
    // The tab's filter applies to History too.
    await sidebar.getByRole("searchbox", { name: "Filter Decisions" }).fill("keys")
    await expect(rows).toHaveCount(1)
    await sidebar.getByRole("searchbox", { name: "Filter Decisions" }).fill("")
    // Opening a row shows the record in its reader and writes nothing.
    await rows.nth(0).click()
    await expect(page).toHaveURL(/item=attention%3Afixture%3Ah_answered/)
    await expect(page.locator('[data-attention-id="h_answered"]')).toBeVisible()
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "page")
    await page.waitForTimeout(500)
    assert.deepEqual(writes, [], `${name}: browsing history wrote nothing: ${JSON.stringify(writes)}`)
    // The choice is remembered for this window.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(sidebar.getByRole("radio", { name: "History" })).toHaveAttribute("aria-checked", "true", { timeout: 120_000 })
    console.log(`HISTORY ${name}: 6 outcomes newest first with words, keyboard switch, filter, read-only open, remembered`)
    await context.close()
  }
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("PASS decision-history")

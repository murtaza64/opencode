import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
preview.fixture.mail = () => ({ editspace: "fixture", lane: "fixture", messages: [{ id: "mail_1", ts: Date.now(), from: "OpenCode", to: "Reviewer", direction: "sent", deliveries: [], kind: "notice", text: "Comparing the bounded attention interface." }] })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript(directory => {
  localStorage.setItem("es-app-all-projects", "true")
  localStorage.setItem("es-app-sidebar-pins", JSON.stringify([JSON.stringify([directory, "ses_a"])]))
}, directory)
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
let dashboardOffline = false
await context.route("**/es/api/state?*", async route => {
  if (dashboardOffline) return route.fulfill({ status: 503, json: { error: "source offline" } })
  const response = await route.fetch()
  const body = await response.json()
  body.prs_at = Date.now() / 1000
  body.unattached_prs = [{ repo: "example/repo", number: 1, url: "https://github.com/example/repo/pull/1", state: "merged", title: "Confirmed cached merge" }, { repo: "example/repo", number: 2, url: "https://github.com/example/repo/pull/2" }]
  await route.fulfill({ response, json: body })
})
const page = await context.newPage()
const errors = []
page.on("pageerror", error => errors.push(error.message))
const emitSource = (type, properties) => {
  for (const [response, stream] of preview.fixture.eventStreams) if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
}
const record = () => page.locator('[data-attention-id="decision_1"]')
const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click()
try {
  await page.goto(preview.url)
  await expect(page.getByRole("heading", { name: "Pinned agents 1", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Pinned agents" })).toContainText("Reviewing the attention interface")
  await expect(page.locator(".home-request")).toContainText("per_home")
  await expect(page.getByRole("heading", { name: "Needs you 3", exact: true })).toBeVisible()
  expect(preview.fixture.calls.filter(call => call.path === "/api/mail")).toHaveLength(0)
  await page.locator(".home-activity summary").click()
  dashboardOffline = true
  preview.fixture.emitDashboard("state")
  await expect(page.locator(".home-warning")).toContainText("Dashboard source unavailable")
  await page.locator(".es-switcher").selectOption("fixture")
  await expect(page.getByRole("heading", { name: "Pinned agents 1", exact: true })).toBeVisible()
  await page.locator(".es-switcher").selectOption("__all__")
  dashboardOffline = false
  preview.fixture.emitDashboard("state")
  await expect(page.locator(".home-warning")).toHaveCount(0)
  await expect(page.locator(".home-activity")).toContainText("Comparing the bounded attention interface")
  await expect(page.locator(".home-activity-row")).toHaveCount(3)
  await page.getByRole("group", { name: "Activity filter", exact: true }).getByRole("button", { name: "Major", exact: true }).click()
  await expect(page.locator(".home-activity-row")).toHaveCount(1)
  await expect(page.locator(".home-activity-row")).toContainText("cache observed")
  await page.getByRole("group", { name: "Activity filter", exact: true }).getByRole("button", { name: "Mail", exact: true }).click()
  await expect(page.locator(".home-activity-row")).toHaveCount(1)
  await expect(page.locator(".home-activity-row")).toContainText("minor · mail")
  await expect(page.getByRole("heading", { name: "Needs you 3", exact: true })).toBeVisible()
  await page.locator(".home-activity summary").click()
  expect(preview.ledger.workCalls.map(call => call.id)).toEqual(["ses_a"])
  expect(preview.fixture.calls.filter(call => call.generate === "true")).toEqual([])
  const work = preview.fixture.currentWork
  preview.fixture.currentWork = (...args) => {
    const result = work(...args)
    result.summary.status = "stale"
    return result
  }
  await expect(page.getByRole("region", { name: "Pinned agents" })).toContainText("summary stale", { timeout: 12_000 })
  await record().getByText("Record & history", { exact: true }).click()
  await expect(record().locator("pre")).toContainText('"revision": 1')
  // Selecting an option is the answer. A stale revision cannot overwrite a newer producer update.
  await record().getByRole("radio", { name: "Small scope", exact: true }).check()
  preview.ledger.records[0].revision++
  await record().getByRole("button", { name: "Send Small scope", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("record changed")
  await record().getByRole("radio", { name: "Small scope", exact: true }).check()
  preview.ledger.operator = false
  let dropResponse = true
  await context.route("**/es/api/attention/*/commands?*", async route => {
    const response = await route.fetch()
    if (dropResponse && response.status() === 200) { dropResponse = false; await route.abort("failed"); return }
    await route.fulfill({ response })
  })
  await record().getByRole("button", { name: "Send Small scope", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Outcome unknown")
  await page.getByRole("button", { name: "Retry same action", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  const posts = preview.ledger.calls.filter(call => call.path.endsWith("/commands"))
  expect(posts.at(-1).body.command_id).toBe(posts.at(-2).body.command_id)
  expect(posts.at(-1).body).toMatchObject({ action: "answer", choice_id: "small" })
  expect("text" in posts.at(-1).body).toBe(false)
  expect(posts.every(call => call.csrf === "1")).toBe(true)
  expect(preview.ledger.calls.filter(call => call.path === "/session" && call.method === "POST")).toHaveLength(2)
  await page.reload()
  await page.getByRole("button", { name: "Answered 1", exact: true }).click()
  await expect(record()).toContainText("Small scope")
  await record().getByRole("button", { name: "Mark resolved" }).click()
  await page.getByRole("button", { name: "History 1", exact: true }).click()
  await record().getByText("Record & history", { exact: true }).click()
  await expect(record().locator("pre")).toContainText('"actor": "producer"')
  await expect(record().locator("pre")).toContainText('"revision": 4')
  await page.getByRole("button", { name: "Open 2", exact: true }).click()
  await page.locator('[data-attention-id="other_decision"]').getByRole("button", { name: "Snooze 1h" }).click()
  await page.getByRole("button", { name: "Snoozed 1", exact: true }).click()
  await expect(page.locator('[data-attention-id="other_decision"]')).toContainText("Snoozed until")
  preview.ledger.partial = true
  await refresh()
  await expect(page.locator(".home-warning")).toContainText("Some projects unavailable; this list may be incomplete.")
  await expect(page.locator('[data-attention-id="other_decision"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Return to Needs you" })).toBeDisabled()
  await page.locator(".es-switcher").selectOption("fixture")
  preview.ledger.partial = false
  preview.ledger.status = 503
  await page.locator(".es-switcher").selectOption("__all__")
  await refresh()
  await expect(page.getByRole("alert")).toContainText("Last-known records are retained")
  await expect(page.locator('[data-attention-id="other_decision"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Return to Needs you" })).toBeDisabled()
  preview.ledger.status = 200
  await refresh()
  await page.getByRole("button", { name: "Return to Needs you" }).click()
  await page.getByRole("button", { name: "Open 2", exact: true }).click()
  const question = { id: "que_home", sessionID: "ses_b", questions: [{ header: "Scope", question: "A healthy source question", options: [{ label: "Continue", description: "Continue" }] }] }
  preview.fixture.questions = [question]
  emitSource("question.asked", question)
  await expect(page.locator(".home-request").filter({ hasText: "que_home" })).toBeVisible()
  await context.route("**/oc/permission?*", route => route.abort("failed"))
  await refresh()
  await page.getByText("Source requests with unknown outcome (1)", { exact: true }).click()
  await expect(page.locator(".home-unknown")).toContainText("source unavailable")
  await expect(page.locator(".home-request").filter({ hasText: "que_home" })).toBeVisible()
  preview.fixture.questions = []
  emitSource("question.replied", { sessionID: "ses_b", requestID: "que_home", answers: [["Continue"]] })
  await expect(page.locator(".home-request").filter({ hasText: "que_home" })).toHaveCount(0)
  await expect(page.locator(".home-unknown")).not.toContainText("que_home")
  await context.unroute("**/oc/permission?*")
  await refresh()
  await expect(page.locator(".home-request")).toContainText("per_home")
  preview.fixture.permissions = []
  await refresh()
  await page.locator(".home-unknown summary").click()
  await expect(page.locator(".home-unknown")).toContainText("no longer pending; outcome unknown")
  // Keyboard/RTL/mixed text; no horizontal clipping inside the Home at narrow widths.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  preview.ledger.records[1].title = "قرار التنفيذ — OpenCode v2"
  await refresh()
  await expect(page.locator('[data-attention-id="other_decision"]')).toContainText("قرار التنفيذ")
  await page.setViewportSize({ width: 760, height: 1000 })
  expect(await page.locator("main.attention-home").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.getByRole("region", { name: "Pinned agents" }).getByRole("link", { name: "Composer fixture", exact: true }).click()
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Draft survives Home navigation; do not send")
  await page.locator(".sidebar a[href='/']").first().click()
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible()
  await page.getByRole("region", { name: "Pinned agents" }).getByRole("link", { name: "Composer fixture", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Draft survives Home navigation; do not send")
  expect(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(errors).toEqual([])
  preview.ledger.operator = false
  preview.ledger.denyOperator = true
  const readOnly = await browser.newPage()
  await readOnly.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await readOnly.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await readOnly.goto(preview.url)
  await expect(readOnly.locator(".home-login")).toContainText("Read-only")
  await expect(readOnly.locator(".home-decision").first().getByRole("button", { name: "Send answer" })).toBeDisabled()
  await expect(readOnly.locator(".home-decision").first().getByRole("radio").first()).toBeDisabled()
  await readOnly.close()
  console.log("PASS attention Home: explicit choices/CAS/ambiguous retry, reload/history/snooze, partial/offline retained records, exact source disappearance, pinned-only telemetry, no generated fleet summaries, RTL/mixed text, session/draft navigation, no runtime writes")
} finally { await browser.close(); await preview.close() }

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
const refresh = () => page.getByRole("button", { name: "Refresh sources", exact: true }).click()
const queue = page.getByRole("complementary", { name: "Desk queue" })
const item = title => queue.locator(".desk-item").filter({ hasText: title })
const history = queue.locator(".desk-history")
const agents = () => page.getByRole("region", { name: "Pinned agents" })
try {
  // Front desk is home: "/" lists what needs you; pinned agents moved into the Agents pane.
  await page.goto(preview.url)
  await expect(page.getByRole("heading", { name: "Front desk", exact: true })).toBeVisible()
  await expect(queue.getByRole("heading", { name: "Needs you 3", exact: true })).toBeVisible()
  await expect(item("per_home").or(item("bun test")).or(item("bash ·"))).toHaveCount(1)
  await queue.getByRole("button", { name: /^Agents/ }).click()
  await expect(page.getByRole("heading", { name: "Pinned agents 1", exact: true })).toBeVisible()
  await expect(agents()).toContainText("Reviewing the attention interface")
  expect(preview.fixture.calls.filter(call => call.path === "/api/mail")).toHaveLength(0)
  await page.locator(".home-activity summary").click()
  dashboardOffline = true
  preview.fixture.emitDashboard("state")
  await expect(page.locator('.desk-source[data-state="unavailable"], .desk-source[data-state="error"]').filter({ hasText: "Dashboard" })).toHaveCount(1)
  dashboardOffline = false
  preview.fixture.emitDashboard("state")
  await expect(page.locator(".home-activity")).toContainText("Comparing the bounded attention interface")
  await expect(page.locator(".home-activity-row")).toHaveCount(3)
  await page.getByRole("group", { name: "Activity filter", exact: true }).getByRole("button", { name: "Major", exact: true }).click()
  await expect(page.locator(".home-activity-row")).toHaveCount(1)
  await page.getByRole("group", { name: "Activity filter", exact: true }).getByRole("button", { name: "Mail", exact: true }).click()
  await expect(page.locator(".home-activity-row")).toContainText("minor · mail")
  await page.locator(".home-activity summary").click()
  expect(preview.ledger.workCalls.map(call => call.id)).toEqual(["ses_a"])
  expect(preview.fixture.calls.filter(call => call.generate === "true")).toEqual([])
  // Decisions open in the evidence pane with their native ledger controls.
  await item("Choose the bounded implementation scope").click()
  await record().getByText("Record & history", { exact: true }).click()
  await expect(record().locator("pre")).toContainText('"revision": 1')
  // Selecting an option is the answer. A stale revision cannot overwrite a newer producer update.
  await record().getByRole("radio", { name: "Small scope", exact: true }).check()
  preview.ledger.records[0].revision++
  await record().getByRole("button", { name: "Send Small scope", exact: true }).click()
  await expect(queue.locator(".home-notice")).toContainText("record changed")
  await record().getByRole("radio", { name: "Small scope", exact: true }).check()
  preview.ledger.operator = false
  let dropResponse = true
  await context.route("**/es/api/attention/*/commands?*", async route => {
    const response = await route.fetch()
    if (dropResponse && response.status() === 200) { dropResponse = false; await route.abort("failed"); return }
    await route.fulfill({ response })
  })
  await record().getByRole("button", { name: "Send Small scope", exact: true }).click()
  await expect(queue.locator(".home-notice")).toContainText("Outcome unknown")
  await queue.getByRole("button", { name: "Retry same action", exact: true }).click()
  await expect(queue.locator(".home-notice")).toContainText("Answer saved")
  const posts = preview.ledger.calls.filter(call => call.path.endsWith("/commands"))
  expect(posts.at(-1).body.command_id).toBe(posts.at(-2).body.command_id)
  expect(posts.at(-1).body).toMatchObject({ action: "answer", choice_id: "small" })
  expect("text" in posts.at(-1).body).toBe(false)
  expect(posts.every(call => call.csrf === "1")).toBe(true)
  // The answered decision stays selected with its delivery status, and is listed under Answered.
  await expect(record().locator(".home-delivery")).toContainText("Small scope")
  await expect(history.locator("summary")).toContainText("Answered & history 1")
  await page.reload()
  await history.locator("summary").click()
  await history.getByRole("button", { name: "Answered 1", exact: true }).click()
  await history.locator(".desk-item").filter({ hasText: "Choose the bounded implementation scope" }).click()
  await expect(record()).toContainText("Small scope")
  await record().getByRole("button", { name: "Mark resolved" }).click()
  await history.getByRole("button", { name: "Resolved 1", exact: true }).click()
  await history.locator(".desk-item").filter({ hasText: "Choose the bounded implementation scope" }).click()
  await record().getByText("Record & history", { exact: true }).click()
  await expect(record().locator("pre")).toContainText('"actor": "producer"')
  await item("Other project decision").click()
  await page.locator('[data-attention-id="other_decision"]').getByRole("button", { name: "Snooze 1h" }).click()
  await expect(page.locator('[data-attention-id="other_decision"]')).toContainText("Snoozed until")
  await expect(history.getByRole("button", { name: "Snoozed 1", exact: true })).toBeVisible()
  preview.ledger.partial = true
  await refresh()
  await expect(queue.locator(".desk-source").filter({ hasText: "Attention ledger" })).not.toHaveAttribute("data-state", "current")
  await expect(page.locator('[data-attention-id="other_decision"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Return to Needs you" })).toBeDisabled()
  preview.ledger.partial = false
  await refresh()
  await page.getByRole("button", { name: "Return to Needs you" }).click()
  await expect(item("Other project decision")).toHaveCount(1)
  const question = { id: "que_home", sessionID: "ses_b", questions: [{ header: "Scope", question: "A healthy source question", options: [{ label: "Continue", description: "Continue" }] }] }
  preview.fixture.questions = [question]
  emitSource("question.asked", question)
  await expect(queue.locator(".desk-item-kind[data-kind=question]")).toHaveCount(1)
  await context.route("**/oc/permission?*", route => route.abort("failed"))
  await refresh()
  await queue.getByText("Requests with unknown outcome (1)", { exact: true }).click()
  await expect(queue.locator(".home-unknown")).toContainText("source unavailable")
  preview.fixture.questions = []
  emitSource("question.replied", { sessionID: "ses_b", requestID: "que_home", answers: [["Continue"]] })
  await expect(queue.locator(".desk-item-kind[data-kind=question]")).toHaveCount(0)
  await context.unroute("**/oc/permission?*")
  preview.fixture.permissions = []
  await refresh()
  await queue.locator(".home-unknown summary").click()
  await expect(queue.locator(".home-unknown")).toContainText("no longer pending; outcome unknown")
  // RTL/mixed text; no horizontal clipping at narrow widths.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  preview.ledger.records[1].title = "قرار التنفيذ — OpenCode v2"
  await refresh()
  await expect(item("قرار التنفيذ")).toHaveCount(1)
  await page.setViewportSize({ width: 760, height: 1000 })
  expect(await page.locator("main.desk").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await queue.getByRole("button", { name: /^Agents/ }).click()
  await agents().getByRole("link", { name: "Composer fixture", exact: true }).click()
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Draft survives Front desk navigation; do not send")
  await page.locator(".sidebar a[href='/']").first().click()
  await expect(page.getByRole("heading", { name: "Front desk", exact: true })).toBeVisible()
  await queue.getByRole("button", { name: /^Agents/ }).click()
  await agents().getByRole("link", { name: "Composer fixture", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Draft survives Front desk navigation; do not send")
  // Old /desk links land on the Front desk at "/".
  await page.goto(`${preview.url}/desk`)
  await expect(page).toHaveURL(`${preview.url}/`)
  await expect(page.getByRole("heading", { name: "Front desk", exact: true })).toBeVisible()
  expect(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  expect(errors).toEqual([])
  preview.ledger.operator = false
  preview.ledger.denyOperator = true
  const readOnly = await browser.newPage()
  await readOnly.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await readOnly.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await readOnly.goto(preview.url)
  await expect(readOnly.locator(".desk-queue .home-login")).toContainText("Read-only")
  await readOnly.locator(".desk-item").filter({ hasText: "قرار التنفيذ" }).click()
  await expect(readOnly.locator(".home-decision").first().getByRole("button", { name: "Send answer" })).toBeDisabled()
  await readOnly.close()
  console.log("PASS attention on Front desk: explicit choices/CAS/ambiguous retry, not-sent/resolved/snoozed history, partial/offline sources, exact source disappearance, Agents pane telemetry, no generated fleet summaries, RTL/mixed text, session/draft navigation, /desk redirect, no runtime writes")
} finally { await browser.close(); await preview.close() }

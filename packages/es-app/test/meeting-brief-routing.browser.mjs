// Meeting briefs (DD meeting-briefs DEVELOP; attention-lead routing contract ltrpotzl): a record with `routing` renders
// one row per item (who -> whom, its summary). Updates carry "with Send" and no toggle; proposals and desk actions are
// toggles bound to the apply option's multi input, recommended ones on and sensitive ones never preselected. The request
// prose moves into Details. Send answers apply with the toggled ids; "Record only" answers record with no picks.
// Desktop, then 390px RTL. Disposable fixture. Run from packages/es-app: node test/meeting-brief-routing.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const now = Date.now()
const record = (id, extra) => ({ id, editspace: "fixture", revision: 1, status: "open", kind: "decision", title: "Route today's stand-up",
  context: "Meeting summary. R1: canary healthy. P1: remind you Thursday. Long prose that should stay folded.",
  producer_session: "ses_a", origin_session: "ses_a", gate_key: `${id}:v1`, source_ref: { session_id: "ses_a", directory }, decision: null,
  delivery_state: "not-requested", created_at: now - 60_000, updated_at: now - 60_000, snoozed_until: null, artifact: null, ...extra })
const routing = { source: { kind: "meeting", title: "Daily stand-up", at: now - 3_600_000 }, items: [
  { id: "u1", kind: "update", to: "opencode/release-lane", summary: "Canary is healthy" },
  { id: "p1", kind: "proposal", to: "opencode/docs-lane", summary: "Ask for the final changelog by Friday", recommended: true },
  { id: "d1", kind: "desk-action", summary: "Remind you Thursday 10:00 to review onboarding copy", recommended: true },
  { id: "p2", kind: "proposal", to: "opencode/infra-lane", summary: "Rotate the staging credentials", recommended: true, sensitive: true },
] }
const apply = { id: "apply", label: "Send updates and do the selected", input: { kind: "multi", label: "Do these", required: false, choices: [
  { id: "p1", label: "Ask for the final changelog by Friday" }, { id: "d1", label: "Remind you Thursday" }, { id: "p2", label: "Rotate the staging credentials" }] } }
const recordOnly = { id: "record", label: "Record only (send nothing)" }
preview.ledger.operator = true
preview.fixture.permissions = []
preview.ledger.cloudLanes = []
preview.ledger.records = [record("brief_1", { routing, options: [apply, recordOnly] }), record("brief_2", { title: "Route the planning chat", routing, options: [apply, recordOnly] }),
  record("plain_1", { title: "Pick a retention window", options: [{ id: "a", label: "30 days" }, { id: "b", label: "90 days" }] })]
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
const commands = () => preview.ledger.calls.filter(call => call.method === "POST" && call.path.endsWith("/commands"))
const card = id => page.locator(`article.home-decision[data-attention-id="${id}"]`)
const open = async id => {
  await page.goto(`${preview.url}/?item=${encodeURIComponent(`attention:fixture:${id}`)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(card(id)).toBeVisible({ timeout: 120_000 })
}
try {
  await open("brief_1")
  const rows = card("brief_1").getByRole("list", { name: "What Send does" }).locator(".routing-item")
  await expect(rows).toHaveCount(4)
  // The update comes first, with no toggle, and says it goes with Send.
  await expect(rows.nth(0)).toHaveAttribute("data-kind", "update")
  await expect(rows.nth(0).locator(".routing-auto")).toHaveText("with Send")
  await expect(rows.nth(0).getByRole("switch")).toHaveCount(0)
  await expect(rows.nth(0)).toContainText("release-lane")
  // Recommended proposals and desk actions start on; a sensitive one never does.
  const changelog = card("brief_1").getByRole("switch", { name: "Ask for the final changelog by Friday (to docs-lane)" })
  const remind = card("brief_1").getByRole("switch", { name: "Remind you Thursday 10:00 to review onboarding copy (Porter does this)" })
  const rotate = card("brief_1").getByRole("switch", { name: "Rotate the staging credentials (to infra-lane)" })
  await expect(changelog).toBeChecked()
  await expect(remind).toBeChecked()
  await expect(rotate).not.toBeChecked()
  // Less text: no option radios, the source line, the prose behind Details.
  await expect(card("brief_1").locator("input[type=radio]")).toHaveCount(0)
  await expect(card("brief_1").locator(".routing-source")).toContainText("Daily stand-up")
  await expect(card("brief_1").locator(".home-decision-explain .home-request-text")).toHaveCount(0)
  await expect(card("brief_1").locator(".home-details .home-original")).toContainText("Long prose")
  // Send names what it does and sends the toggled ids with the apply option.
  await remind.uncheck()
  const send = card("brief_1").getByRole("button", { name: "Send updates and do the selected: 1 update, 1 selected" })
  await expect(send).toBeEnabled()
  await send.click()
  await expect.poll(() => commands().length).toBe(1)
  expect(commands()[0].body).toMatchObject({ action: "answer", choice_id: "apply", input_value: ["p1"] })
  // The client settles the answer before the next page load (an answer in flight across a reload is "unknown outcome").
  await expect(page.getByText("You chose Send updates and do the selected").first()).toBeVisible()

  // Record only answers with no picks.
  await open("brief_2")
  await card("brief_2").getByRole("button", { name: "Record only (send nothing)" }).click()
  await expect.poll(() => commands().length).toBe(2)
  expect(commands()[1].body).toMatchObject({ action: "answer", choice_id: "record" })
  expect(commands()[1].body.input_value).toBeUndefined()

  // A record without routing uses direct option buttons.
  await open("plain_1")
  await expect(card("plain_1").getByRole("button", { name: "30 days", exact: true })).toBeVisible()
  await expect(card("plain_1").locator(".routing-items")).toHaveCount(0)

  // 390px RTL: rows stay whole.
  await open("brief_1")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  for (const row of await card("brief_1").locator(".routing-item").all()) {
    await row.scrollIntoViewIfNeeded()
    const box = await row.boundingBox()
    if (!box || box.x < 0 || box.x + box.width > 390) throw new Error(`clipped at 390px RTL: ${JSON.stringify(box)}`)
  }
  await page.screenshot({ path: "/tmp/meeting-brief-rtl-390.png" })
  expect(errors).toEqual([])
  console.log("PASS meeting brief routing: update rows with Send and no toggle, recommended on, sensitive off, prose in Details, Send apply with picks, Record only, plain record unchanged, 390px RTL")
} finally {
  await browser.close()
  await preview.close()
}

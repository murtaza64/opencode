// The Front desk chat keeps the conversation primary: a one-line progress summary above it opens to what is in
// progress and recent results: questions its conversation asked owners by es mail, in two
// projects, with delivery and the owner's answer, from the dashboard's per-session mail timeline (GET /api/mail
// ?es=&session=). Display only: no button, no send, Send unchanged. Stand-in dashboard; no real mail.
// Run from packages/es-app: node test/desk-followups.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const now = Date.now()
const delivery = state => ({ message_id: "x", recipient: "owner", session: "ses_owner", mode: "actionable", state, request_id: "r", error: null, presented_at: null, handled_at: null })
// The desk conversation is ses_a; its questions live in each project's own mail threads.
const timelines = {
  fixture: [
    { id: "alpha#4", ts: "", created_ms: now - 600_000, from: "ses_a", sender_session: "ses_a", to: "alpha", kind: "question", text: "Which build is on the Mini?", deliveries: [delivery("handled")], direction: "sent" },
    { id: "alpha#5", ts: "", created_ms: now - 120_000, from: "alpha", sender_session: "ses_alpha", to: "ses_a", kind: "answer", in_reply_to: "alpha#4", text: "Build 42", deliveries: [], direction: "received" },
    { id: "alpha#6", ts: "", created_ms: now - 60_000, from: "ses_a", sender_session: "ses_a", to: "alpha", kind: "notice", text: "Thanks", deliveries: [], direction: "sent" },
  ],
  other: [
    { id: "beta#1", ts: "", created_ms: now - 3 * 86_400_000, from: "ses_a", sender_session: "ses_a", to: "beta", kind: "question", text: "Old question", deliveries: [delivery("handled")], direction: "sent" },
    { id: "beta#3", ts: "", created_ms: now - 2 * 86_400_000, from: "beta", sender_session: "ses_beta", to: "ses_a", kind: "answer", in_reply_to: "beta#1", text: "Old answer", deliveries: [], direction: "received" },
    { id: "gamma#1", ts: "", created_ms: now - 30_000, from: "ses_a", sender_session: "ses_a", to: "gamma", kind: "question", text: "No receipt yet", deliveries: [], direction: "sent" },
    { id: "beta#2", ts: "", created_ms: now - 300_000, from: "ses_a", sender_session: "ses_a", to: "beta", kind: "question", text: "Is the nightly green?", deliveries: [delivery("admitted")], direction: "sent" },
  ],
}
const reads = []
// One durable case with two parts owned by existing actors, as the dashboard stores it (metadata only).
const caseFile = { format: "front-desk-cases/1", cases: [{ case_id: "two-parts", title: "Directions and a workspace", updated: now,
  intents: [{ id: "private-read", state: "working", owner: { lane: "exploration", editspace: "directions", host: "mini" }, next: "meeting synthesis" },
    { id: "workspace", state: "delivered", owner: { lane: "project-lead", editspace: "streams", host: "mini" } }],
  deliverables: [{ id: "deck", intent: "workspace", label: "Explainer deck", ref: "http://127.0.0.1:64924/", read_back: true }, { id: "report", intent: "private-read", label: "Private report" }] }] }
const preview = await startAttentionPreview([{ name: "cases", configureServer(server) {
  server.middlewares.use("/es/api/frontdesk/cases", (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(caseFile)) })
} }])
preview.fixture.permissions = []
preview.fixture.mail = (name, session) => { reads.push([name, session]); return { editspace: name, lane: "", messages: session === "ses_a" ? timelines[name] ?? [] : [] } }
const browser = await chromium.launch({ channel: "chrome", headless: true })
let failed = false
try {
  for (const [view, viewport, rtl] of [["desktop", { width: 1440, height: 1000 }, false], ["390", { width: 390, height: 844 }, false], ["rtl", { width: 390, height: 844 }, true]]) {
    const context = await browser.newContext({ viewport })
    await context.addInitScript(value => { if (window === window.top) { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)); localStorage.setItem("es-app:companion:work", "1") } }, { session: "ses_a", directory })
    await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(90_000)
    page.on("pageerror", error => console.error(`pageerror: ${error.message}`))
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
    // Narrow windows float the companion; open it the way a person would.
    if (viewport.width < 1200) await page.locator("[data-nav=front-desk]").first().click().catch(() => undefined)
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
    // One summary line above the chat; nothing else until the human opens it (no case needs them here).
    const strip = page.getByRole("region", { name: "Desk progress" })
    const summary = strip.getByRole("button", { name: /in progress/ })
    await expect(summary).toHaveText(/3 in progress · 2 done/, { timeout: 300_000 })
    await expect(summary).toHaveAttribute("aria-expanded", "false")
    await expect(strip.locator(".desk-progress-row")).toHaveCount(0)
    const stripHeight = (await strip.boundingBox()).height
    assert(stripHeight <= 40, `${view}: folded strip is ${stripHeight}px tall`)
    // The conversation sits right under it.
    const chatTop = await page.locator(".desk-chat textarea").evaluate(element => element.getBoundingClientRect().top)
    assert(chatTop > (await strip.boundingBox()).y, `${view}: chat above the strip`)
    // Opened: in progress first (newest first), then results; labels are human, owners and ids only in Details.
    await summary.click()
    const rows = strip.locator(".desk-progress-row")
    await expect(rows.locator(".desk-progress-label")).toHaveText(["Private read", "No receipt yet", "Is the nightly green?", "Workspace", "Which build is on the Mini?"])
    await expect(rows.nth(0)).toContainText("meeting synthesis")
    await expect(rows.nth(1)).toContainText("Asked gamma · delivery unknown")
    await expect(rows.nth(3)).toContainText("Delivered")
    await expect(rows.nth(3).getByRole("link", { name: "Workspace" })).toHaveAttribute("href", "http://127.0.0.1:64924/")
    await expect(rows.nth(4)).toContainText("Answered by alpha")
    await expect(strip).not.toContainText("Thanks")
    for (const text of ["ses_", "exploration · directions", "two-parts", "alpha#"]) await expect(strip.locator(".desk-progress-line")).not.toContainText([text])
    await rows.nth(0).getByText("Details").click()
    await expect(rows.nth(0).locator(".desk-progress-detail")).toContainText("owner exploration · directions · mini")
    // No send or answer controls: only the summary toggle and Details disclosures.
    await expect(strip.locator("input, textarea")).toHaveCount(0)
    await expect(strip.locator("button")).toHaveCount(1)
    await expect(page.getByRole("button", { name: "Ask in background" })).toHaveCount(0)
    assert(await strip.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${view}: strip overflows`)
    const list = strip
    if (shots) await list.screenshot({ path: path.join(shots, `followups-${view}.png`) })
    console.log(`PROGRESS ${view}: folded to one summary line (<=40px) above the chat; opened: 3 in progress + 2 done with human labels, owners/ids only in Details; one results link; no send controls`)
    await context.close()
  }
  assert(reads.some(([name, session]) => name === "fixture" && session === "ses_a") && reads.some(([name, session]) => name === "other" && session === "ses_a"))
  assert.equal(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method) && call.path?.includes("mail")).length, 0)
  console.log("READS: one per project for the desk session; no mail writes")
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("PASS desk-followups")

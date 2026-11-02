// The Front desk chat keeps the conversation primary: one line of counts above it, plus one line naming what needs the
// human, opens to rows grouped by who has the next move (needs you, working, waiting on owners, unrecognised state)
// and a closed Completed list holding every result, newest first. Each row is one line and opens in place by keyboard.
// Sources: durable cases and the questions its conversation asked owners by es mail, in two
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
// One durable case owned by existing actors, as the dashboard stores it (metadata only). Only parts with a state_at
// have an age; the case's own `updated` is never one.
const caseFile = { format: "front-desk-cases/1", cases: [{ case_id: "two-parts", title: "Directions and a workspace", updated: now,
  intents: [{ id: "private-read", state: "working", owner: { lane: "exploration", editspace: "directions", host: "mini" }, next: "meeting synthesis" },
    { id: "workspace", state: "delivered", state_at: now - 3_600_000, owner: { lane: "project-lead", editspace: "streams", host: "mini" } },
    { id: "archived-part", state: "done", state_at: now - 5 * 86_400_000 }, { id: "odd-part", state: "paused" },
    { id: "pick-scope", state: "waiting", needs: { action: "answer", label: "Pick the first workspace before the outline starts", ref: "attention:fixture:pick-scope" }, owner: { lane: "project-lead", editspace: "streams", host: "mini" } },
    // Waiting with no recorded action: its owner's blocker, so it waits on owners and never reads as a question for you.
    { id: "client-guard", state: "waiting", next: "client guard rejects the current target", owner: { lane: "upgrade" } }],
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
    // Folded: one line of counts and one line naming what needs the human; nothing else until it is opened.
    const strip = page.getByRole("region", { name: "Desk progress" })
    const summary = strip.locator(".desk-progress-summary")
    await expect(summary).toHaveText(/1 need you.*1 working.*3 waiting.*1 unclear.*4 done/, { timeout: 300_000 })
    await expect(summary).toHaveAttribute("aria-expanded", "false")
    await expect(strip.locator(".desk-progress-row")).toHaveCount(0)
    const peek = strip.locator(".desk-progress-peek")
    await expect(peek).toContainText("Pick scope")
    await expect(peek).toContainText("age unknown")
    const stripHeight = (await strip.boundingBox()).height
    assert(stripHeight <= 64, `${view}: folded strip is ${stripHeight}px tall`)
    for (const line of [summary, peek]) assert((await line.boundingBox()).height <= 30, `${view}: a folded line wraps`)
    await expect(strip).not.toContainText("Details")
    // The conversation sits right under it, never under the strip.
    const chatTop = await page.locator(".desk-chat textarea").evaluate(element => element.getBoundingClientRect().top)
    assert(chatTop > (await strip.boundingBox()).y, `${view}: chat above the strip`)
    // The needs line opens the strip on that row, its detail showing and focused.
    await peek.click()
    await expect(summary).toHaveAttribute("aria-expanded", "true")
    const needs = strip.locator('.desk-progress-row[data-group="needs"]')
    await expect(needs.locator(".desk-progress-line")).toBeFocused()
    await expect(needs.locator(".desk-progress-detail")).toContainText("Pick the first workspace before the outline starts")
    await expect(needs.locator(".desk-progress-detail")).toContainText(/Changed\s*unknown/)
    // Opened: grouped by who has the next move, newest first, undated last; one line per row; owners and ids only
    // in a row's detail. Results wait behind a closed Completed control, kept however old.
    // Each group head: a shape, its name and a count; colour is never the only signal.
    await expect(strip.locator(".desk-progress-group")).toHaveText([/!\s*Needs you\s*1/, /◐\s*Working\s*1/, /◷\s*Waiting on owners\s*3/, /\?\s*State not recognised\s*1/, /✓\s*Completed\s*4/])
    const rows = strip.locator('.desk-progress-rows:not([data-group="result"]) > .desk-progress-row')
    await expect(rows.locator(".desk-progress-label")).toHaveText(["Pick scope", "Private read", "No receipt yet", "Is the nightly green?", "Client guard", "Odd part"])
    // Rows are terse: what, who, when. Status waits in the detail; only an ask or a blocker shows on the row.
    await expect(rows.nth(1).locator(".desk-progress-owner")).toHaveText("exploration")
    await expect(rows.nth(1)).toContainText("age unknown")
    await expect(rows.nth(1)).not.toContainText("meeting synthesis")
    await expect(rows.nth(2).locator(".desk-progress-owner")).toHaveText("gamma")
    await expect(rows.nth(2).locator(".desk-progress-flag")).toHaveText(/!\s*no receipt/)
    await expect(rows.nth(4).locator(".desk-progress-flag")).toHaveText(/!\s*blocked/)
    await expect(rows.nth(5).locator(".desk-progress-flag")).toHaveText(/\?\s*paused/)
    for (const index of [1, 2, 4, 5]) assert((await rows.nth(index).locator(".desk-progress-line").boundingBox()).height <= 30, `${view}: row ${index} wraps`)
    // Ages share one column, also on a row without an owner.
    const ageEnds = await rows.locator(".desk-progress-age").evaluateAll(list => list.map(element => element.getBoundingClientRect()[getComputedStyle(element).direction === "rtl" ? "left" : "right"]))
    assert(Math.max(...ageEnds) - Math.min(...ageEnds) <= 1, `${view}: age column ragged ${ageEnds}`)
    // Keyboard: arrows walk the rows, Enter opens one in place.
    await page.keyboard.press("ArrowDown")
    await expect(rows.nth(1).locator(".desk-progress-line")).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(rows.nth(1).locator(".desk-progress-detail")).toContainText("owner exploration · directions · mini")
    await expect(rows.nth(1).locator(".desk-progress-detail")).toContainText("meeting synthesis")
    await expect(rows.nth(1).locator(".desk-progress-line")).toHaveAttribute("aria-expanded", "true")
    const done = strip.locator(".desk-progress-done")
    await expect(done).toHaveAttribute("aria-expanded", "false")
    await done.click()
    const completed = strip.locator('.desk-progress-rows[data-group="result"] > .desk-progress-row')
    await expect(completed.locator(".desk-progress-label")).toHaveText(["Which build is on the Mini?", "Workspace", "Old question", "Archived part"])
    await expect(completed.nth(0).locator(".desk-progress-owner")).toHaveText("alpha")
    await expect(completed.nth(1)).toContainText("60m ago")
    await expect(completed.nth(1).getByRole("link", { name: "Open Explainer deck" })).toHaveAttribute("href", "http://127.0.0.1:64924/")
    await expect(completed.nth(2).locator(".desk-progress-owner")).toHaveText("beta")
    await expect(completed.nth(2)).toContainText("2d ago")
    await expect(completed.nth(3)).toContainText("5d ago")
    await expect(strip).not.toContainText("Thanks")
    for (const text of ["ses_", "exploration · directions", "two-parts", "alpha#"]) await expect(strip.locator(".desk-progress-line")).not.toContainText([text])
    // No send or answer controls; the draft and session stay the chat's.
    await expect(strip.locator("input, textarea")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Ask in background" })).toHaveCount(0)
    assert(await strip.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${view}: strip overflows`)
    const stack = await page.evaluate(() => ({ strip: document.querySelector(".desk-progress").getBoundingClientRect().bottom, chat: document.querySelector(".desk-companion .session-page").getBoundingClientRect().top }))
    assert(stack.chat >= stack.strip - 0.5, `${view}: opened strip overlaps the chat (${stack.strip} > ${stack.chat})`)
    if (shots) await strip.screenshot({ path: path.join(shots, `followups-open-${view}.png`) })
    // Escape folds back to the summary.
    await done.focus()
    await page.keyboard.press("Escape")
    await expect(summary).toHaveAttribute("aria-expanded", "false")
    await expect(summary).toBeFocused()
    console.log(`PROGRESS ${view}: folded to counts + one needs line (<=64px) above the chat; needs line opens its row; grouped one-line rows (needs, working, waiting, unrecognised), undated "age unknown"; arrows/Enter/Escape; closed Completed holds 4 results newest first incl. >24h; owners/ids only in row detail; no send controls`)
    await context.close()
  }
  // Off Decisions (a session page, Decisions never mounted): a companion send still carries the desk's cases.
  // The desk context goes only with an idle send, so the desk session is idle here.
  {
    preview.fixture.status = "idle"
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(value => { if (window === window.top) { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)); localStorage.setItem("es-app:companion:session", "1") } }, { session: "ses_a", directory })
    await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(90_000)
    const sent = []
    page.on("request", request => { if (request.method() === "POST" && /\/oc\/session\/ses_a\/(prompt_async|input)/.test(request.url())) sent.push(request.postData() ?? "") })
    await page.goto(`${preview.origin}/session/ses_b?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
    const companion = page.locator(".desk-companion")
    await expect(companion.locator("textarea")).toBeVisible({ timeout: 300_000 })
    assert.equal(await page.locator(".desk-evidence, [data-desk-item]").count(), 0, "Decisions queue is mounted")
    await companion.locator("textarea").fill("Where does the directions work stand?")
    await companion.getByRole("button", { name: "Send", exact: true }).click()
    await expect.poll(() => sent.length, { timeout: 30_000 }).toBeGreaterThan(0)
    const body = sent.join("\n")
    assert(body.includes("open cases (durable, metadata only") && body.includes("case two-parts") && body.includes("private-read [working]"), body.slice(0, 600))
    assert(body.includes("cases only; no queue view is open"), "cases-only note")
    console.log("OFF DECISIONS: a companion send from a session page carries the case lines (Decisions never mounted)")
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

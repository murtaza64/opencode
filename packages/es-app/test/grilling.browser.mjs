// A grilling session (the "Next fixture: alignment" series shape): one Needs-you entry, a focused stepper, each answer
// its own ledger command. Frames: node test/grilling.browser.mjs --shots <dir>
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : `${tmpdir()}/grilling-frames`
mkdirSync(shots, { recursive: true })
const preview = await startAttentionPreview()
const base = preview.ledger.records[0]
const other = { id: "other", label: "Other", input: { kind: "text", label: "Your proposal", required: true } }
const question = (index, title, context, options, extra = {}) => ({
  ...base, id: `grill_${index}`, title, context, series: { id: "next-fixture-alignment", index, title: "Next fixture: alignment" },
  gate_key: `fixture:alignment:${index}`, revision: 1, content_revision: 1, status: "open", answer: null, decision: null, delivery_state: "not-requested",
  options: [...options, other], recommendation: options[0].id, created_at: Date.now() - 600_000, ...extra,
})
const first = [
  question(1, "Keep rejected work in the middle column?", "Murtaza's meeting readback favors three stream-admin lists, not a detailed pipeline. Recommendation: Pending | Active / needs action | Post-merge. Unhandled rejections stay visibly marked in the middle because they still need a choice.",
    [{ id: "middle", label: "Yes, middle" }, { id: "own", label: "Own column" }]),
  question(2, "Show one actionable blocker fact?", "The inbox shows identity, current state, one short blocker fact only when needed to choose, and available actions. No causal explanation.",
    [{ id: "yes", label: "Yes: one blocker fact" }, { id: "state", label: "State + actions only" }]),
  question(3, "Visualize the action, not the stream recipe?", "Action vignettes per decision, not a pipeline diagram of how the stream works.",
    [{ id: "yes", label: "Yes: action vignettes" }, { id: "type", label: "Per stream type" }]),
  question(4, "Pause native feedback plumbing too?", "Native feedback is useful but not needed for the alignment fixture.",
    [{ id: "pause", label: "Yes, pause it" }, { id: "keep", label: "Keep building it" }]),
]
const followUps = () => [
  question(5, "Keep a rejection in the phase it happened in?", "A rejection is a condition on the item, not a destination.\n\nPending · In progress · Post-merge — a pre-start rejection stays Pending, an in-flight one stays In progress, a post-merge failure stays Post-merge with different choices. No generating/checking subcolumns, and no implied lifecycle change.",
    [{ id: "keep", label: "Yes: keep the phase; mark the blocker there" }, { id: "middle", label: "Put all unresolved rejections in the middle" }], { caused_by: { index: 1 }, created_at: Date.now() }),
  question(6, "One visual vocabulary for Desk streams, the Streams list and admin?", "Same glyphs and phase names everywhere a stream appears.",
    [{ id: "same", label: "Yes, same vocabulary" }, { id: "pipe", label: "Admin gets its own pipe" }], { created_at: Date.now() }),
  question(7, "Keep factual history for replay?", "History stays factual: what happened and when, no narrative.",
    [{ id: "keep", label: "Yes, keep replay" }, { id: "drop", label: "Drop history" }], { created_at: Date.now() }),
]
preview.ledger.records.push(...first)
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const key = "series:fixture:ses_a:next-fixture-alignment"
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
page.on("pageerror", error => errors.push(error.message))
const entry = page.locator(`nav.sidebar [data-nav-item="${key}"]`)
const grill = page.locator(".grill")
const pane = grill.locator(".grill-question")
const answers = () => preview.ledger.calls.filter(call => call.path.endsWith("/commands") && call.body.action === "answer")
const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click()
try {
  await page.goto(preview.url, { timeout: 300_000 })
  // One entry per session, with progress and the asking agent; no row per question.
  await expect(entry).toHaveCount(1)
  await expect(entry.locator(".nav-title")).toHaveText("Grilling · Next fixture: alignment")
  await expect(entry.locator(".nav-grill-progress")).toContainText("0 of 4 answered")
  await expect(entry.locator(".grill-segment")).toHaveCount(4)
  await expect(page.locator('nav.sidebar [data-nav-item^="attention:fixture:grill_"]')).toHaveCount(0)
  // The entry's bar is the stepper's segmented bar, wide enough to read.
  const bar = await entry.locator(".grill-segments").boundingBox()
  if (!bar || bar.width < 80 || bar.height < 4) throw Error(`inbox progress bar too small ${JSON.stringify(bar)}`)
  await entry.screenshot({ path: `${shots}/1-inbox-entry.png` })

  await entry.click()
  await expect(pane).toHaveAttribute("data-index", "1")
  await expect(pane.locator("h4")).toHaveText("Keep rejected work in the middle column?")
  // Question, hinge, choices; the agent's paragraph waits under More context.
  await expect(pane.locator(".grill-hinge")).toHaveText("Murtaza's meeting readback favors three stream-admin lists, not a detailed pipeline.")
  await expect(pane.locator(".grill-more")).not.toHaveAttribute("open", "")
  await expect(pane.locator(".grill-choice")).toHaveText([/Yes, middle/, "Own column"])
  await expect(page.locator(".grill-choice[data-recommended]")).toBeFocused()
  // Q1: free text through the producer's Other option.
  await page.keyboard.press("/")
  await expect(pane.getByRole("textbox", { name: "Your proposal" })).toBeFocused()
  await page.keyboard.type("maybe the column it was rejected from?")
  await page.keyboard.press("Enter")
  await expect(pane.locator(".grill-sent")).toHaveText("Sent ✓")
  await expect(pane).toHaveAttribute("data-index", "2")
  await expect(page.locator(".grill-choice[data-recommended]")).toBeFocused()
  // Q2: Enter answers the recommendation.
  await page.keyboard.press("Enter")
  await expect(pane).toHaveAttribute("data-index", "3")
  await expect(grill.locator(".grill-count")).toHaveText("2 of 4 answered")
  await expect(grill.locator('.grill-rail-item[data-index="1"] .grill-rail-note')).toContainText('you: “maybe the column it was rejected from?”')
  await page.locator(".grill").screenshot({ path: `${shots}/2-stepper-mid-session.png` })
  await page.keyboard.press("Enter")
  // Q4: free text again.
  await expect(pane).toHaveAttribute("data-index", "4")
  await pane.getByRole("textbox", { name: "Your proposal" }).fill("nice to have… no rush")
  await pane.getByRole("button", { name: "Send", exact: true }).click()
  await expect(grill.locator(".grill-summary h4")).toHaveText("Decided so far")
  await expect(grill.locator(".grill-decided li")).toHaveCount(4)

  // The agent withdraws its Q1 assumption and follows up: Q5 names the answer that caused it.
  first[0].delivery_state = "handled"
  first[1].delivery_state = "admitted"
  preview.ledger.records.push(...followUps())
  await refresh()
  await expect(pane).toHaveAttribute("data-index", "5")
  await expect(pane.locator(".grill-because")).toHaveText("↳ because you said “maybe the column it was rejected from?” (Q1)")
  await expect(grill.locator(".grill-meta")).toContainText("4 of 7 answered · 3 follow-ups")
  await expect(grill.locator('.grill-rail-item[data-index="5"] .grill-rail-note')).toHaveText("follow-up to Q1")
  await expect(grill.locator('.grill-rail-item[data-index="6"] .grill-rail-note')).toHaveText("follow-up")
  await expect(grill.locator('.grill-rail-item[data-index="1"] .grill-delivered')).toContainText("✓ delivered")
  await expect(entry.locator(".nav-grill-progress")).toContainText("4 of 7 answered · 3 follow-ups")
  await page.locator(".grill").screenshot({ path: `${shots}/3-follow-up.png` })

  const swipe = dx => page.locator(".grill-pane").evaluate((element, dx) => {
    const rect = element.getBoundingClientRect()
    const touch = x => new Touch({ identifier: 1, target: element, clientX: x, clientY: rect.top + 40 })
    const x = rect.left + rect.width / 2
    element.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(x)], changedTouches: [touch(x)], bubbles: true }))
    element.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(x + dx)], bubbles: true }))
  }, dx)
  // RTL: the rail sits on the start (right) side, nothing overflows, quotes keep their order, and a swipe toward
  // the start edge (rightward) goes forward.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const sides = await page.evaluate(() => ({ rail: document.querySelector(".grill-rail").getBoundingClientRect().left, pane: document.querySelector(".grill-pane").getBoundingClientRect().left,
    scroll: document.documentElement.scrollWidth, width: window.innerWidth }))
  if (!(sides.rail > sides.pane) || sides.scroll > sides.width) throw Error(`RTL layout ${JSON.stringify(sides)}`)
  await expect(pane.locator(".grill-because")).toHaveText("↳ because you said “maybe the column it was rejected from?” (Q1)")
  const rtlBar = await entry.locator(".grill-segments").boundingBox()
  if (!rtlBar || rtlBar.width < 80) throw Error(`RTL inbox bar ${JSON.stringify(rtlBar)}`)
  await page.locator(".grill").screenshot({ path: `${shots}/8-rtl.png` })
  await swipe(120)
  await expect(pane).toHaveAttribute("data-index", "6")
  await swipe(-120)
  await expect(pane).toHaveAttribute("data-index", "5")
  await page.evaluate(() => { document.documentElement.dir = "ltr" })

  // K goes back: an answered question shows the recorded answer and its delivery, with no second answer control.
  await page.locator(".grill-choice[data-recommended]").focus()
  await page.keyboard.press("k")
  await expect(pane).toHaveAttribute("data-index", "4")
  await expect(pane.locator(".grill-recorded")).toContainText("“nice to have… no rush”")
  await expect(pane.locator(".grill-choice")).toHaveCount(0)
  await page.locator(".grill").screenshot({ path: `${shots}/4-answered-revisit.png` })
  await page.keyboard.press("j")
  await expect(pane).toHaveAttribute("data-index", "5")

  // See all: every question as a card, answered independently.
  await page.getByRole("button", { name: "See all", exact: true }).click()
  await expect(grill.locator(".attention-series-question")).toHaveCount(7)
  await page.setViewportSize({ width: 1440, height: 2400 })
  await page.locator(".grill").screenshot({ path: `${shots}/5-see-all.png` })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("button", { name: "One at a time", exact: true }).click()
  await expect(pane).toHaveAttribute("data-index", "5")

  // Esc pauses: the item closes and the entry keeps its place.
  await page.locator(".grill-choice[data-recommended]").focus()
  await page.keyboard.press("Escape")
  await expect(grill).toHaveCount(0)
  await expect(entry).toHaveCount(1)

  // Phone: the question fills the screen, the rail folds into a "1 of 3"-style strip, and a swipe moves between questions.
  await page.setViewportSize({ width: 390, height: 844 })
  await entry.click()
  await expect(pane).toHaveAttribute("data-index", "5")
  await expect(grill.locator(".grill-strip")).toHaveText(/5 of 7/)
  await expect(grill.locator(".grill-rail")).toBeHidden()
  const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }))
  if (fit.scroll > fit.width) throw Error(`phone overflow ${JSON.stringify(fit)}`)
  await grill.scrollIntoViewIfNeeded()
  await page.locator(".grill").screenshot({ path: `${shots}/6-phone.png` })
  await swipe(-120)
  await expect(pane).toHaveAttribute("data-index", "6")
  await swipe(120)
  await expect(pane).toHaveAttribute("data-index", "5")
  await grill.locator(".grill-strip").click()
  await expect(grill.locator(".grill-rail")).toBeVisible()
  // Choosing from the strip returns focus to that question's recommendation.
  await grill.locator('.grill-rail-item[data-index="5"]').click()
  await expect(grill.locator(".grill-rail")).toBeHidden()
  await expect(page.locator(".grill-choice[data-recommended]")).toBeFocused()
  await page.setViewportSize({ width: 1440, height: 900 })

  // DD (a): a stale revision is refused, said so, and never auto-answered: the agent reworded Q5 after this page read it.
  const q5 = preview.ledger.records.find(record => record.id === "grill_5")
  q5.revision++
  q5.content_revision++
  q5.title = "Keep a rejection in the phase it happened in (reworded)?"
  await page.keyboard.press("Enter")
  await expect(page.locator(".home-notice")).toContainText("This record changed. Review the current revision before choosing again.")
  await expect(pane.locator("h4")).toHaveText("Keep a rejection in the phase it happened in (reworded)?")
  await expect(pane).toHaveAttribute("data-index", "5")
  await expect(pane.locator(".grill-recorded")).toHaveCount(0)
  await expect(pane.locator(".grill-choice")).toHaveCount(2)
  if (q5.answer || q5.status !== "open") throw Error("stale revision was answered")
  await page.waitForTimeout(600)
  await expect(pane).toHaveAttribute("data-index", "5")
  if (answers().length !== 5) throw Error(`stale refusal retried on its own: ${answers().length} answer commands`)
  await page.locator(".grill-choice[data-recommended]").focus()

  // Q5–Q7 by keyboard; the last answer empties the queue entry and the summary closes the session.
  await page.keyboard.press("Enter")
  await expect(pane).toHaveAttribute("data-index", "6")
  await page.keyboard.press("Enter")
  await expect(pane).toHaveAttribute("data-index", "7")
  // DD (f): with one unanswered question left, the session is still in Needs you.
  await expect(entry).toHaveCount(1)
  await expect(entry.locator(".nav-grill-progress")).toContainText("6 of 7 answered")
  await page.keyboard.press("Enter")
  await expect(grill.locator(".grill-summary h4")).toHaveText("Decided so far")
  await expect(grill.locator(".grill-decided li")).toHaveCount(7)
  await expect(grill.locator('.grill-decided li[data-index="1"] .grill-decided-answer')).toHaveText("“maybe the column it was rejected from?”")
  await expect(grill.locator('.grill-decided li[data-index="5"] .grill-decided-answer')).toHaveText("Yes: keep the phase; mark the blocker there")
  await expect(entry).toHaveCount(0)
  await expect(page.locator(".home-warning")).toHaveCount(0)
  await page.locator(".grill").screenshot({ path: `${shots}/7-summary.png` })
  await expect(page.locator(".grill-summary-done")).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(grill).toHaveCount(0)

  // Each answer is its own command on its own record at that record's revision; nothing is bundled. Q5's first
  // command is the refused stale one; the second is the deliberate answer to the reworded question.
  const sent = answers().map(call => [call.path, call.body.expected_revision, call.body.choice_id, call.body.input_value ?? call.body.text])
  const expected = [["/grill_1/commands", 1, "other", "maybe the column it was rejected from?"], ["/grill_2/commands", 1, "yes", undefined], ["/grill_3/commands", 1, "yes", undefined],
    ["/grill_4/commands", 1, "other", "nice to have… no rush"], ["/grill_5/commands", 1, "keep", undefined], ["/grill_5/commands", 2, "keep", undefined], ["/grill_6/commands", 1, "same", undefined], ["/grill_7/commands", 1, "keep", undefined]]
  if (JSON.stringify(sent) !== JSON.stringify(expected)) throw Error(`per-record answers ${JSON.stringify(sent)}`)
  if (answers().some(call => call.csrf !== "1" || !call.body.command_id)) throw Error("missing command identity or CSRF")
  if (new Set(answers().map(call => call.body.command_id)).size !== 8) throw Error("command ids reused")
  if (errors.length) throw Error(errors.join("\n"))
  if (preview.fixture.calls.some(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))) throw Error("unexpected runtime writes")
  console.log(`PASS grilling: one Needs-you entry (progress, follow-ups), stepper focus on recommendation, / free text via Other, Enter answers + auto-advance, follow-up "because" from caused_by, K/J, See all board, Esc pause keeps place, phone strip + swipe, stale revision refused and not auto-answered (DD a), entry kept with one unanswered (DD f), summary after the queue entry clears, 7 answers as separate per-record commands plus the refused stale one, no runtime writes. Frames: ${shots}`)
} finally {
  await context.close()
  await browser.close()
  await preview.close()
}

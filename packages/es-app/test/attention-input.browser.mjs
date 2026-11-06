// Choices that require input on the Front desk, against the disposable attention fixture: every option is a button;
// an input option's click opens its labelled control under the buttons with a Send beside it, which stays
// disabled with the reason until the value is valid; Esc folds it and keeps the value; the exact value is sent once;
// unknown kinds keep radio + Send and are not sendable; a ledger refusal is shown with its reason. Mobile and RTL. No runtime writes.
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const base = preview.ledger.records[1]
const PEOPLE = [{ id: "alice", label: "Alice R." }, { id: "bob", label: "Bob S." }, { id: "carol", label: "Carol T." }]
const gate = (id, title, input) => ({
  ...base, id, editspace: "fixture", title, gate_key: `fixture:${id}:v1`, lane: "work", recommendation: null,
  options: [{ id: "name-reviewers", label: "Name reviewers", input }, { id: "arrange-myself", label: "Arrange reviews myself" }, { id: "defer", label: "Keep this queue parked" }],
})
preview.ledger.records.push(
  gate("cleanup", "Who should review the nine cleanup PR pairs?", { kind: "text", label: "Reviewers", required: true, hint: "One per pair, or a pool" }),
  gate("pool", "Pick reviewers from the owners", { kind: "multi", label: "Reviewers", required: true, choices: PEOPLE, max: 2 }),
  gate("future", "A newer input kind", { kind: "date", label: "Review by", required: true }),
  gate("refused", "Old client path", { kind: "text", label: "Reviewers", required: true }),
  gate("noted", "Claim the EKS migration repos", { kind: "multi", label: "Repos", required: true, choices: [{ id: "repo-a", label: "repo-a" }, { id: "repo-b", label: "repo-b" }, { id: "repo-c", label: "repo-c" }] }),
  gate("noted-optional", "Claim the second batch", { kind: "multi", label: "Repos", required: true, choices: [{ id: "repo-a", label: "repo-a" }, { id: "repo-b", label: "repo-b" }] }),
)
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const itemURL = (key) => `${preview.url}/?item=${encodeURIComponent(key)}`
const open = async (viewport, id) => {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on("pageerror", error => errors.push(error.message))
  // The dev preview compiles on first load; a busy host can take longer than the default.
  await page.goto(itemURL(`attention:fixture:${id}`), { timeout: 300_000 })
  return { context, page, card: page.locator(`[data-attention-id="${id}"]`) }
}
const posts = (id) => preview.ledger.calls.filter(call => call.path === `/${id}/commands`)
const MAPPING = "math-backend: @alice\nmusic-backend: @bob\nrest: pool @carol, @dan"
try {
  {
    const { context, card, page } = await open({ width: 1440, height: 1000 }, "cleanup")
    const reviewers = card.getByRole("textbox", { name: "Reviewers" })
    await expect(reviewers).toHaveCount(0)
    await expect(card.getByRole("radio")).toHaveCount(0)
    const name = card.getByRole("button", { name: "Name reviewers", exact: true })
    await name.click()
    await expect(reviewers).toBeVisible()
    await expect(reviewers).toBeFocused()
    await expect(reviewers).toHaveAttribute("placeholder", "One per pair, or a pool")
    const send = card.getByRole("button", { name: "Send", exact: true })
    await expect(send).toBeDisabled()
    await expect(card.locator(".home-input-problem")).toHaveText("Add reviewers to send")
    await reviewers.fill("   ")
    await expect(send).toBeDisabled()
    await reviewers.fill(MAPPING)
    // Esc folds the field back to its button; reopening keeps the typed value.
    await page.keyboard.press("Escape")
    await expect(reviewers).toHaveCount(0)
    await expect(card.locator(".home-input-problem")).toHaveCount(0)
    await expect(name).toBeFocused()
    await name.click()
    await expect(reviewers).toHaveValue(MAPPING)
    await send.dblclick()
    await expect(page.locator(".home-notice")).toContainText("Answer saved")
    const [sent, ...extra] = posts("cleanup")
    if (extra.length || sent.body.choice_id !== "name-reviewers" || sent.body.input_value !== MAPPING || "text" in sent.body) throw Error(`cleanup answer ${JSON.stringify(posts("cleanup"))}`)
    // The answered request is filed in History, where it shows what was provided.
    await page.reload()
    await expect(card.locator(".home-input-value")).toContainText("Reviewers")
    await expect(card.locator(".home-input-value bdi")).toHaveText(MAPPING)
    await context.close()
  }
  {
    // Grounded candidates: checkboxes up to max, ids sent in the order picked.
    const { context, card, page } = await open({ width: 1440, height: 1000 }, "pool")
    await card.getByRole("button", { name: "Name reviewers", exact: true }).click()
    const group = card.getByRole("group", { name: "Reviewers" })
    await group.getByRole("checkbox", { name: "Carol T." }).check()
    await group.getByRole("checkbox", { name: "Alice R." }).check()
    await group.getByRole("checkbox", { name: "Bob S." }).check()
    await expect(card.locator(".home-input-problem")).toHaveText("Pick at most 2")
    await expect(card.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
    await group.getByRole("checkbox", { name: "Bob S." }).uncheck()
    await card.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page.locator(".home-notice")).toContainText("Answer saved")
    const [sent] = posts("pool")
    if (JSON.stringify(sent.body.input_value) !== JSON.stringify(["carol", "alice"])) throw Error(`pool answer ${JSON.stringify(sent.body)}`)
    // The answered request is filed in History, where it shows what was provided.
    await page.reload()
    await expect(card.locator(".home-input-value bdi")).toHaveText("Carol T., Alice R.")
    await context.close()
  }
  {
    // A checklist option also takes an optional note in the same answer: one POST with choice + checklist + text.
    const { context, card, page } = await open({ width: 1440, height: 1000 }, "noted")
    await card.getByRole("button", { name: "Name reviewers", exact: true }).click()
    const repos = card.getByRole("group", { name: "Repos" })
    await repos.getByRole("checkbox", { name: "repo-a" }).check()
    await repos.getByRole("checkbox", { name: "repo-b" }).check()
    const note = card.getByRole("textbox", { name: /Add a note/ })
    await note.fill("Claimed under the EKS migration")
    // Enter in the note never submits; Cmd/Ctrl+Enter or Send does.
    await note.press("Enter")
    await page.waitForTimeout(400)
    if (posts("noted").length) throw Error(`Enter in the note sent ${JSON.stringify(posts("noted"))}`)
    // Collapse keeps the unsubmitted choice, checklist and note; so does a remount.
    await page.keyboard.press("Escape")
    await expect(card.getByRole("checkbox", { name: "repo-a" })).toHaveCount(0)
    await card.getByRole("button", { name: "Name reviewers", exact: true }).click()
    await expect(card.getByRole("checkbox", { name: "repo-a" })).toBeChecked()
    await expect(card.getByRole("checkbox", { name: "repo-b" })).toBeChecked()
    await expect(card.getByRole("textbox", { name: /Add a note/ })).toHaveValue(/Claimed under the EKS migration/)
    // Reconnect/remount keeps the unsubmitted choice, checklist and note.
    await page.reload()
    await expect(card.getByRole("checkbox", { name: "repo-a" })).toBeChecked()
    await expect(card.getByRole("checkbox", { name: "repo-b" })).toBeChecked()
    await expect(card.getByRole("textbox", { name: /Add a note/ })).toHaveValue(/Claimed under the EKS migration/)
    await card.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page.locator(".home-notice")).toContainText("Answer saved")
    const [sent, ...extra] = posts("noted")
    if (extra.length || sent.body.choice_id !== "name-reviewers" || JSON.stringify(sent.body.input_value) !== JSON.stringify(["repo-a", "repo-b"])
      || sent.body.text.trim() !== "Claimed under the EKS migration") throw Error(`checklist + note answer ${JSON.stringify(posts("noted"))}`)
    await context.close()
  }
  {
    // The note is optional: the same checklist sends with no text field at all.
    const { context, card, page } = await open({ width: 1440, height: 1000 }, "noted-optional")
    await card.getByRole("button", { name: "Name reviewers", exact: true }).click()
    await card.getByRole("group", { name: "Repos" }).getByRole("checkbox", { name: "repo-a" }).check()
    await card.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page.locator(".home-notice")).toContainText("Answer saved")
    const [sent] = posts("noted-optional")
    if (sent.body.choice_id !== "name-reviewers" || JSON.stringify(sent.body.input_value) !== JSON.stringify(["repo-a"]) || "text" in sent.body) throw Error(`optional note answer ${JSON.stringify(sent.body)}`)
    await context.close()
  }
  {
    // A kind this app does not know: no control, not sendable, the other options still are.
    const { context, card } = await open({ width: 1440, height: 1000 }, "future")
    await card.getByRole("radio", { name: "Name reviewers", exact: true }).check()
    await expect(card.locator(".home-input")).toHaveCount(0)
    await expect(card.locator(".home-input-problem")).toContainText("newer app or the source thread")
    await expect(card.getByRole("button", { name: "Send Name reviewers" })).toBeDisabled()
    await card.getByRole("radio", { name: "Keep this queue parked", exact: true }).check()
    await expect(card.getByRole("button", { name: "Send Keep this queue parked" })).toBeEnabled()
    await context.close()
  }
  {
    // An older client that drops the value is refused by the ledger, and the reason is shown; nothing is saved.
    const { context, card, page } = await open({ width: 1440, height: 1000 }, "refused")
    await context.route("**/es/api/attention/refused/commands?*", route => {
      const body = JSON.parse(route.request().postData())
      delete body.input_value
      return route.continue({ postData: JSON.stringify(body) })
    })
    await card.getByRole("button", { name: "Name reviewers", exact: true }).click()
    await card.getByRole("textbox", { name: "Reviewers" }).fill("@alice")
    // Enter sends a valid open field.
    await card.getByRole("textbox", { name: "Reviewers" }).press("Enter")
    await expect(page.locator(".home-notice")).toContainText("Not sent: Reviewers is required for Name reviewers.")
    if (preview.ledger.records.find(record => record.id === "refused").status !== "open") throw Error("refused answer must leave the record open")
    await context.close()
  }
  {
    // Mobile + RTL: the input fits without horizontal scrolling and keeps its own direction.
    preview.ledger.records.push(gate("mobile", "Mobile reviewers", { kind: "text", label: "Reviewers", required: true }))
    const { context, card, page } = await open({ width: 390, height: 844 }, "mobile")
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await card.getByRole("button", { name: "Name reviewers", exact: true }).click()
    const field = card.getByRole("textbox", { name: "Reviewers" })
    await field.fill("مراجع: @alice — math-backend")
    const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth,
      right: document.querySelector('[data-attention-id="mobile"] .home-input textarea').getBoundingClientRect().right }))
    if (fit.scroll > fit.width || fit.right > fit.width) throw Error(`mobile overflow ${JSON.stringify(fit)}`)
    const style = await field.evaluate(element => ({ dir: element.getAttribute("dir"), direction: getComputedStyle(element).direction }))
    if (style.dir !== "auto" || style.direction !== "rtl") throw Error(`RTL input ${JSON.stringify(style)}`)
    await context.close()
  }
  const writes = preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))
  if (writes.length) throw Error(`unexpected runtime writes ${JSON.stringify(writes)}`)
  if (errors.length) throw Error(errors.join("\n"))
  console.log("PASS option inputs: every option a button, input option opens its control with Send beside it, Send disabled with reason until valid, Esc folds and keeps the value, exact text/multi values sent once and shown after answering, max enforced, unknown kind not sendable, ledger refusal reason shown, mobile, RTL, no runtime writes")
} finally {
  await browser.close()
  await preview.close()
}

// Written answers on Home against the disposable attention fixture: keyboard send, lost response,
// legacy record-only choice, delivery evidence/recovery, drafts, mobile and RTL. No runtime writes.
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const FLEET = "i like the direction of A and C"
const preview = await startAttentionPreview()
preview.ledger.records[0].lane = "orchestrator"
preview.ledger.records.push({ ...preview.ledger.records[1], id: "uncommitted", editspace: "fixture", title: "Uncommitted first attempt", gate_key: "fixture:uncommitted:v1", lane: "work" })
preview.ledger.records.push({ ...preview.ledger.records[1], id: "open_ended", editspace: "fixture", title: "What should the release note say?", options: [], recommendation: null, gate_key: "fixture:note:v1", lane: null, source_ref: { ...preview.ledger.records[1].source_ref, session_id: "ses_top" } })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const open = async (viewport) => {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(preview.url)
  return { context, page }
}
try {
  const { context, page } = await open({ width: 1440, height: 1000 })
  const record = page.locator('[data-attention-id="decision_1"]')
  const answer = record.getByRole("textbox", { name: /Your answer/ })
  await expect(answer).toBeEnabled()
  await expect(record.getByRole("button", { name: "Send answer" })).toBeDisabled()
  await answer.fill("   ")
  await expect(record.getByRole("button", { name: "Send answer" })).toBeDisabled()
  await answer.fill(FLEET)
  await expect(record.locator(".home-answer")).toContainText("currently owns lane orchestrator through verified handoffs")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  let drop = true
  await context.route("**/es/api/attention/*/commands?*", async route => {
    const response = await route.fetch()
    if (drop && response.status() === 200) { drop = false; await route.abort("failed"); return }
    await route.fulfill({ response })
  })
  await answer.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator(".home-notice")).toContainText("Outcome unknown")
  await expect(answer).toHaveValue(FLEET)
  // The server committed the first attempt; reload keeps the exact pending identity for retry.
  await page.reload()
  await expect(page.locator(".home-notice")).toContainText("An answer sent before reload has an unknown outcome. Retrying repeats the same answer; no new answer is created.")
  await page.getByRole("button", { name: "Retry same action", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  if (await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("es-attention-pending:")))) throw Error("settled answer must clear its pending identity")
  const posts = preview.ledger.calls.filter(call => call.path.endsWith("/commands"))
  if (posts.length !== 2 || posts[0].body.command_id !== posts[1].body.command_id) throw Error("lost response must retry the same command identity")
  if (JSON.stringify(posts[1].body) !== JSON.stringify({ action: "answer", text: FLEET, expected_revision: 1, command_id: posts[0].body.command_id })) throw Error(`unexpected answer body ${JSON.stringify(posts[1].body)}`)
  await expect(page.getByRole("button", { name: "Answered 1", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(record.locator("pre.home-answer-text")).toHaveText(FLEET)
  await expect(record.locator(".home-delivery")).toContainText("Saved · delivery not yet attempted")
  await expect(page.getByRole("heading", { name: "Needs you 4", exact: true })).toBeVisible()

  const fixtureRecord = preview.ledger.records[0]
  fixtureRecord.delivery_state = "blocked"
  fixtureRecord.delivery = { ...fixtureRecord.delivery, state: "blocked", reason: "owner-unverified" }
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(record.locator(".home-blocked")).toContainText("not on this request's verified handoff chain")
  await expect(record.getByText("Delivered session not yet verified")).toBeVisible()
  preview.ledger.deliveryNext = { state: "admitted", reason: null, session: "ses_successor", session_directory: "/successor/dir", copies: [{ session: "ses_successor", directory: "/successor/dir", state: "admitted", error: null, presented_at: null, handled_at: null }] }
  await record.getByRole("button", { name: "Retry delivery" }).click()
  await expect(record.locator(".home-delivery")).toContainText("Delivered to the agent's input queue · not yet read")
  const delivered = await record.getByRole("link", { name: "Open delivered agent thread" }).getAttribute("href")
  const source = await record.getByRole("link", { name: "Open source thread" }).getAttribute("href")
  if (!delivered.includes("ses_successor") || !decodeURIComponent(delivered).includes("/successor/dir") || decodeURIComponent(source).includes("/successor/dir")) throw Error(`links ${delivered} ${source}`)
  // History refreshes when delivery evidence changes without a revision bump.
  await record.getByText("Record & history", { exact: true }).click()
  await expect(record.locator("details pre")).toContainText('"reason": "admitted"')
  fixtureRecord.delivery_state = "presented"
  fixtureRecord.delivery = { ...fixtureRecord.delivery, state: "presented", updated_at: Date.now() + 1 }
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(record.locator(".home-delivery")).toContainText("Presented to agent · awaiting acknowledgement")
  await expect(record.locator("details pre")).toContainText('"reason": "presented"')

  // Uncommitted first attempt: the request never reached the ledger; reload retries the same identity once.
  await page.getByRole("group", { name: "Attention status" }).getByRole("button", { name: /^Open/ }).click()
  const fresh = page.locator('[data-attention-id="uncommitted"]')
  const freshBox = fresh.getByRole("textbox", { name: /Your answer/ })
  await freshBox.fill("never reached the server")
  // IME composition Enter must not submit.
  await freshBox.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, metaKey: true, isComposing: true, bubbles: true, cancelable: true })))
  await page.waitForTimeout(300)
  if (preview.ledger.calls.some(call => call.path === "/uncommitted/commands")) throw Error("IME composition submitted an answer")
  await context.route("**/es/api/attention/uncommitted/commands?*", route => route.abort("failed"), { times: 1 })
  await fresh.getByRole("button", { name: "Send answer", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Outcome unknown")
  const firstID = await page.evaluate(() => JSON.parse(localStorage.getItem("es-attention-pending:fixture:uncommitted")).body.command_id)
  await page.reload()
  await page.getByRole("button", { name: "Retry same action", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  const committed = preview.ledger.calls.filter(call => call.path === "/uncommitted/commands")
  if (committed.length !== 1 || committed[0].body.command_id !== firstID || committed[0].body.text !== "never reached the server") throw Error(`uncommitted retry ${JSON.stringify(committed)}`)
  await expect(record.locator(".home-copies")).toContainText("ses_successor · admitted")
  await expect(record.getByRole("button", { name: "Retry delivery" })).toHaveCount(0)
  const retries = preview.ledger.calls.filter(call => call.path.endsWith("/delivery"))
  if (retries.length !== 1 || retries[0].csrf !== "1" || JSON.stringify(retries[0].body) !== "{}") throw Error("delivery retry must be one CSRF POST with an empty body")

  // Open-ended asks have no options, only the written answer.
  await page.getByRole("group", { name: "Attention status" }).getByRole("button", { name: /^Open/ }).click()
  const openEnded = page.locator('[data-attention-id="open_ended"]')
  await expect(openEnded.getByRole("radio")).toHaveCount(0)
  await expect(openEnded.getByRole("button", { name: "Review choice" })).toHaveCount(0)
  await expect(openEnded.locator(".home-answer")).toContainText("the requesting session ses_top")
  // Legacy record-only choice remains separate and labeled unsent.
  await page.getByRole("group", { name: "Attention status" }).getByRole("button", { name: /^Open/ }).click()
  const other = page.locator('[data-attention-id="other_decision"]')
  await other.getByRole("radio", { name: "Continue", exact: true }).check()
  await other.getByRole("button", { name: "Review choice", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("Saved only: nothing is sent, resumed or granted.")
  await page.getByRole("button", { name: "Record choice only", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Decision saved · not sent")
  // A later written reply on the recorded card sends text only, not the earlier single choice.
  await page.getByRole("group", { name: "Attention status" }).getByRole("button", { name: /^Recorded/ }).click()
  const recorded = page.locator('[data-attention-id="other_decision"]')
  await expect(recorded).toContainText("Continue · not sent")
  await recorded.getByRole("textbox", { name: /Your answer/ }).fill("Continue with A and C")
  await recorded.getByRole("button", { name: "Send answer", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("Answer saved")
  const reply = preview.ledger.calls.filter(call => call.path === "/other_decision/commands").at(-1).body
  if (reply.action !== "answer" || reply.text !== "Continue with A and C" || "choice_id" in reply) throw Error(`recorded-card reply ${JSON.stringify(reply)}`)
  const keptChoice = preview.ledger.records.find(item => item.id === "other_decision")
  if (keptChoice.decision?.choice_id !== "yes") throw Error("earlier recorded choice must remain")
  await page.getByRole("group", { name: "Attention status" }).getByRole("button", { name: /^Open/ }).click()

  // Drafts survive reload; mixed RTL text keeps its own direction.
  const mixed = "أفضّل A و C — keep `fleet-orbit` as a prototype"
  await page.locator('[data-attention-id="open_ended"]').getByRole("textbox", { name: /Your answer/ }).fill(mixed)
  await page.reload()
  await expect(page.locator('[data-attention-id="open_ended"]').getByRole("textbox", { name: /Your answer/ })).toHaveValue(mixed)
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const box = page.locator('[data-attention-id="open_ended"]').getByRole("textbox", { name: /Your answer/ })
  const style = await box.evaluate(element => ({ dir: element.getAttribute("dir"), align: getComputedStyle(element).textAlign, direction: getComputedStyle(element).direction }))
  if (style.dir !== "auto" || style.align !== "start" || style.direction !== "rtl") throw Error(`RTL textarea ${JSON.stringify(style)}`)
  // Storage failure blocks the send rather than creating an unrecoverable uncertain command.
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.startsWith("es-attention-pending:")) throw new DOMException("full", "QuotaExceededError"); return original.call(this, key, value) } })
  await page.locator('[data-attention-id="open_ended"]').getByRole("button", { name: "Send answer", exact: true }).click()
  await expect(page.locator(".home-notice")).toContainText("was not sent")
  if (preview.ledger.calls.some(call => call.path === "/open_ended/commands")) throw Error("send proceeded without a persisted identity")
  await expect(box).toHaveValue(mixed)
  await context.close()

  // Mobile: the answer field and send control fit without horizontal scrolling.
  const mobile = await open({ width: 390, height: 844 })
  const field = mobile.page.locator('[data-attention-id="open_ended"]').getByRole("textbox", { name: /Your answer/ })
  await field.fill(mixed)
  const fit = await mobile.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth,
    field: document.querySelector('[data-attention-id="open_ended"] textarea').getBoundingClientRect().right }))
  if (fit.scroll > fit.width || fit.field > fit.width) throw Error(`mobile overflow ${JSON.stringify(fit)}`)
  await field.focus()
  await mobile.page.keyboard.press("Tab")
  await expect(mobile.page.locator('[data-attention-id="open_ended"]').getByRole("button", { name: "Send answer" })).toBeFocused()
  await mobile.context.close()

  // A background poll (fresh record objects) keeps the same textarea node, focus, caret and text.
  const held = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  await held.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await held.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const typing = await held.newPage()
  await typing.clock.install()
  await typing.goto(preview.url)
  const heldBox = typing.locator('[data-attention-id="open_ended"]').getByRole("textbox", { name: /Your answer/ })
  await heldBox.fill("abcd")
  await heldBox.evaluate(element => { element.setSelectionRange(1, 3); window.__answerNode = element })
  const listsBefore = preview.ledger.calls.filter(call => call.method === "GET" && call.path === "/").length
  preview.ledger.records.find(item => item.id === "open_ended").updated_at++
  await typing.clock.runFor(31_000)
  await expect.poll(() => preview.ledger.calls.filter(call => call.method === "GET" && call.path === "/").length).toBeGreaterThan(listsBefore)
  await typing.waitForTimeout(300)
  const kept = await heldBox.evaluate(element => ({ same: element === window.__answerNode, focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd, value: element.value }))
  if (!kept.same || !kept.focused || kept.start !== 1 || kept.end !== 3 || kept.value !== "abcd") throw Error(`poll disturbed typing ${JSON.stringify(kept)}`)
  await typing.keyboard.type("X")
  await expect(heldBox).toHaveValue("aXd")
  await held.close()

  const writes = preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))
  if (writes.length) throw Error(`unexpected runtime writes ${JSON.stringify(writes)}`)
  if (errors.length) throw Error(errors.join("\n"))
  console.log("PASS written answers: inline send (Ctrl/Cmd+Enter, no modal), exact text, draft kept on failure, open-ended asks, lost-response retry with same command, answered evidence, blocked reason + retry delivery, legacy record-only choice then text-only written reply (no stale choice_id), draft reload, pending identity survives reload (committed + uncommitted), IME guard, storage-failure blocks send, delivered-session directory link, history refresh on delivery, poll keeps focus/caret, RTL, mobile, no runtime writes")
} finally {
  await browser.close()
  await preview.close()
}

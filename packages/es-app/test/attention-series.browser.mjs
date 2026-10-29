// Seven ordinary ledger records, grouped on the desk but answered independently.
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const base = preview.ledger.records[0]
const members = [1, 2, 3, 4, 5, 6, 7].map(index => ({
  ...base, id: `grill_${index}`, title: `Question ${index}: choose a path`, context: `Decide question ${index} independently.`,
  series: { id: "keyboard-plan", index, title: "Keyboard plan review" }, gate_key: `fixture:grill:${index}`,
  revision: index + 2, content_revision: index + 2, status: "open", answer: null, decision: null,
  options: [{ id: "suggested", label: `Suggested ${index}` }, { id: "alternate", label: `Alternative ${index}` },
    { id: "other", label: "Other", input: { kind: "text", label: "Your proposal", required: true } }],
  recommendation: "suggested",
}))
preview.ledger.records.push(...members)
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const key = "series:fixture:ses_a:keyboard-plan"
const url = `${preview.url}/?item=${encodeURIComponent(key)}`
const output = "/Users/murtaza/editspaces/opencode/lanes/es-app/work/evidence/s6"
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const page = await context.newPage()
page.on("pageerror", error => errors.push(error.message))
const card = page.locator('[data-series-id="keyboard-plan"]')
const row = index => card.locator(`[data-attention-id="grill_${index}"]`)
try {
  await page.goto(url, { timeout: 300_000 })
  await expect(page.locator(`[data-desk-item="${key}"]`)).toHaveCount(1)
  await expect(card.locator(".attention-series-question")).toHaveCount(7)
  await expect(card.locator(".attention-series-progress")).toHaveText("0/7 answered")
  // Progress is neutral text, not the green that means recommended.
  const green = await page.evaluate(() => { const probe = document.body.appendChild(document.createElement("span")); probe.style.color = "var(--green)"; const value = getComputedStyle(probe).color; probe.remove(); return value })
  if (await card.locator(".attention-series-progress").evaluate(element => getComputedStyle(element).color) === green) throw new Error("series progress is green")
  await expect(card.locator(".attention-series-question h4 .home-source")).toHaveText([1, 2, 3, 4, 5, 6, 7].map(index => `Question ${index} · revision ${index + 2}`))
  await expect(row(1).getByRole("radio")).toHaveCount(3)
  await expect(row(1).locator(".home-options [data-recommended]")).toHaveCount(1)
  await row(1).getByRole("radio", { name: "Suggested 1" }).check()
  await row(1).getByRole("button", { name: "Send Suggested 1" }).click()
  await expect(card.locator(".attention-series-progress")).toHaveText("1/7 answered")
  await row(2).getByRole("radio", { name: "Alternative 2" }).check()
  await row(2).getByRole("button", { name: "Send Alternative 2" }).click()
  await expect(card.locator(".attention-series-progress")).toHaveText("2/7 answered")
  await row(3).getByRole("radio", { name: "Other" }).check()
  await row(3).getByRole("textbox", { name: "Your proposal" }).fill("أختار مسارًا ثالثًا — keep exact text")
  await row(3).getByRole("button", { name: "Send Other" }).click()
  await expect(card.locator(".attention-series-progress")).toHaveText("3/7 answered")
  const posts = preview.ledger.calls.filter(call => call.path.endsWith("/commands") && call.body.action === "answer")
  if (JSON.stringify(posts.map(call => [call.path, call.body.expected_revision, call.body.choice_id, call.body.input_value])) !==
    JSON.stringify([["/grill_1/commands", 3, "suggested", undefined], ["/grill_2/commands", 4, "alternate", undefined],
      ["/grill_3/commands", 5, "other", "أختار مسارًا ثالثًا — keep exact text"]])) throw Error(`per-record commands ${JSON.stringify(posts)}`)
  if (posts.some(call => call.csrf !== "1" || !call.body.command_id)) throw Error("missing command identity or CSRF")
  await page.reload()
  await expect(card.locator(".attention-series-progress")).toHaveText("3/7 answered")
  await expect(card.locator(".attention-series-head .home-muted")).toHaveText("Unanswered: Q4, Q5, Q6, Q7")
  await expect(row(2).locator(".attention-series-recorded")).toContainText("Alternative 2")
  await expect(row(2).locator(".attention-series-recorded")).not.toContainText("Suggested 2")
  await expect(row(2).locator(".attention-series-recommended")).toHaveText("Recommended")
  await expect(row(3).locator(".attention-series-recorded pre")).toHaveText("أختار مسارًا ثالثًا — keep exact text")
  members[3].status = "withdrawn"
  members[3].revision++
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(card.locator(".attention-series-progress")).toHaveText("3/6 answered")
  await expect(row(4)).toContainText("Withdrawn")
  await expect(row(4)).toContainText("revision 7")
  await expect(card.locator(".attention-series-head .home-muted")).not.toContainText("Q4")
  // A producer update replaces an open question's content, with a new revision and no inherited draft/answer.
  members[4].revision++
  members[4].content_revision++
  members[4].title = "Question 5: updated plan"
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(row(5)).toContainText("revision 8")
  await expect(row(5)).toContainText("updated plan")
  await expect(row(5).locator(".attention-series-recorded")).toHaveCount(0)
  await expect(card.locator(".attention-series-progress")).toHaveText("3/6 answered")
  await page.setViewportSize({ width: 1280, height: 2600 })
  await card.screenshot({ path: `${output}/series-wide.png` })
  await page.setViewportSize({ width: 360, height: 780 })
  await expect(card).toBeVisible()
  const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }))
  if (fit.scroll > fit.width) throw Error(`narrow overflow ${JSON.stringify(fit)}`)
  await page.setViewportSize({ width: 360, height: 3000 })
  await card.screenshot({ path: `${output}/series-360.png` })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const rtl = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth,
    border: getComputedStyle(document.querySelector(".attention-series-recorded")).borderInlineStartWidth }))
  if (rtl.scroll > rtl.width || rtl.border !== "2px") throw Error(`RTL layout ${JSON.stringify(rtl)}`)
  // One agent thread and one destination per card, not per question; in RTL "To <target>" keeps its reading order.
  await expect(card.getByRole("link", { name: "Agent thread" })).toHaveCount(1)
  const route = card.locator(".attention-series-route bdi[dir=ltr]")
  await expect(route).toHaveCount(1)
  await expect(card.locator(".attention-series-question .home-actions bdi[dir=ltr]")).toHaveCount(0)
  const order = await route.evaluate(el => { const range = document.createRange(); range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, 2); return { to: range.getBoundingClientRect().left, target: el.querySelector("bdi").getBoundingClientRect().left } })
  if (!(order.to < order.target)) throw Error(`RTL "To <target>" order ${JSON.stringify(order)}`)
  await card.screenshot({ path: `${output}/series-rtl-360.png` })
  await row(6).getByRole("radio", { name: "Other" }).check()
  const draft = row(6).getByRole("textbox", { name: "Your proposal" })
  await draft.fill("draft in progress")
  await draft.evaluate(element => { window.__seriesDraft = element })
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(draft).toHaveValue("draft in progress")
  if (!await draft.evaluate(element => element === window.__seriesDraft)) throw Error("refresh replaced an unchanged question while typing")
  members[1].revision++
  members[1].content_revision++
  members[1].status = "open"
  members[1].answer = null
  members[1].title = "Question 2: revised after answer"
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(card.locator(".attention-series-progress")).toHaveText("2/6 answered")
  await expect(row(2)).toContainText("revision 6")
  await expect(row(2)).toContainText("revised after answer")
  await expect(row(2).locator(".attention-series-recorded")).toHaveCount(0)
  await expect(card.locator(".attention-series-head .home-muted")).toContainText("Q2")
  if (errors.length) throw Error(errors.join("\n"))
  if (preview.fixture.calls.some(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))) throw Error("unexpected runtime writes")
  console.log("PASS grilling series: 7 ordered questions, 3 exact per-record revision POSTs (recommended, alternative, Other text), reload 3/7, withdrawn 3/6, updated answered question clears old answer, recorded answer distinct from recommendation, 360px and RTL screenshots, one thread/destination per card in reading order, no runtime writes")
} finally {
  await context.close()
  await browser.close()
  await preview.close()
}

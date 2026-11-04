import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
preview.ledger.operator = true
preview.fixture.permissions = []
preview.ledger.cloudLanes = []
preview.ledger.records = [{ ...preview.ledger.records[0], editspace: "fixture", lane: "upgrade-harvest-lead",
  title: "Post the owners' question in #pd-bee?", recommendation: "draft", options: [{ id: "draft", label: "Draft it in Slack" }, { id: "hold", label: "Not now" }],
  brief: { thing: "response-tagging-backend · stage check", happened: "stage runs 0 replicas; the check needs 1", key: "Nothing changes until an owner says yes",
    action: { verb: "post", to: { slack: "#pd-bee" }, as: "You", text: "Can we scale stage to 1?" },
    options: { draft: { consequence: "Opens #pd-bee with this drafted" } } } }]
// Answered decisions under v1: the lifecycle figure is the only delivery statement, so it must never run ahead of the receipts.
const answered = (id, delivery_state, delivery = null) => ({ ...preview.ledger.records[0], id, gate_key: `life:${id}`, status: "answered", answer: { id: `ans_${id}`, text: "", choice_id: "draft", answered_at: Date.now() - 600_000 },
  delivery_state, delivery, brief: { thing: "response-tagging-backend · stage check", key: "Nothing changes until an owner says yes" } })
preview.ledger.records.push(answered("life_blocked", "blocked", { state: "blocked", reason: "owner-unverified", lane: null, session: null, message_id: null, error: null, updated_at: Date.now(), presented_at: null, handled_at: null }),
  answered("life_pending", "pending"),
  answered("life_copies", "presented", { state: "presented", reason: null, lane: "upgrade-harvest-lead", session: "ses_x", message_id: "m1", error: null, updated_at: Date.now(), presented_at: new Date().toISOString(), handled_at: null,
    copies: [{ session: "ses_y", state: "presented", error: null, presented_at: new Date().toISOString(), handled_at: null }, { session: "ses_z", state: "admitted", error: null, presented_at: null, handled_at: null }] }))
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
// The setting lives in the desk queue header; seed it the way that toggle stores it.
await context.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("es-app:brief-v1", "on"); sessionStorage.setItem("seeded", "1") } })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
try {
  await page.goto(`${preview.url}/?item=attention%3Afixture%3Adecision_1`, { waitUntil: "domcontentloaded" })
  const card = page.locator('article[data-attention-id="decision_1"]').first()
  await expect(card).toBeVisible()
  await expect(card.locator(".brief-v1")).toContainText("Nothing changes until an owner says yes")
  // Rest is the outcome: the drafted message is already there, and the recommended option's consequence shows.
  await expect(card.locator(".brief-act-slack .brief-slack-message")).toBeVisible()
  await expect(card.locator(".brief-slack-draft")).toHaveText("Draft")
  await expect(card.locator(".brief-v1-preview")).toHaveText("Opens #pd-bee with this drafted")
  await expect(card.locator(".brief-figure-frame")).not.toHaveClass(/animate/)
  // Under a v1 brief the legacy request paragraph and the brief job row are gone; Details keeps the request.
  await expect(card.locator(".home-decision-explain")).not.toContainText("Keep the homepage focused")
  await expect(card.getByRole("button", { name: "Prepare brief" })).toHaveCount(0)
  // Measure the brief and its controls, not the whole card.
  const region = () => card.evaluate(element => [".brief-v1", ".home-decision-act"].map(selector => element.querySelector(selector)?.getBoundingClientRect().height))
  const height = await region()
  await card.getByRole("button", { name: /Not now/ }).hover()
  await expect(card.locator(".brief-act-slack")).toHaveClass(/dim/)
  await expect(card.locator(".brief-v1-preview")).toHaveText("")
  await card.getByRole("button", { name: /Draft it in Slack/ }).hover()
  await expect(card.locator(".brief-figure-frame")).toHaveClass(/animate/)
  await expect(card.locator(".brief-act-slack")).not.toHaveClass(/dim/)
  await expect(card.locator(".brief-v1-preview")).toHaveText("Opens #pd-bee with this drafted")
  expect(await region()).toEqual(height)
  for (const [id, shows, never] of [["life_blocked", "Delivery blocked", "Presented"], ["life_pending", "Not delivered yet", "Presented"]]) {
    await page.goto(`${preview.url}/?item=attention%3Afixture%3A${id}`, { waitUntil: "domcontentloaded" })
    const life = page.locator(`article[data-attention-id="${id}"] .brief-life`).first()
    await expect(life).toContainText(shows)
    await expect(life).not.toContainText(never)
    await expect(page.locator(`article[data-attention-id="${id}"]`).first()).not.toContainText("Not delivered yet · ")
    if (shots) await page.locator(`article[data-attention-id="${id}"]`).first().screenshot({ path: path.join(shots, `${id}.png`) })
  }
  // A blocked delivery keeps its reason in the figure (the legacy receipt line is hidden under v1).
  await page.goto(`${preview.url}/?item=attention%3Afixture%3Alife_blocked`, { waitUntil: "domcontentloaded" })
  await expect(page.locator('article[data-attention-id="life_blocked"] .brief-life-note').first()).toContainText("verified handoff chain")
  await page.goto(`${preview.url}/?item=attention%3Afixture%3Alife_copies`, { waitUntil: "domcontentloaded" })
  const copies = page.locator('article[data-attention-id="life_copies"]').first()
  await expect(copies.locator(".brief-life-copies")).toHaveText("+2 copies")
  await expect(copies.locator(".home-delivery .home-copies")).toHaveCount(0)
  await copies.locator("details").last().evaluate(element => { element.open = true })
  await expect(copies.locator('ul.home-copies[aria-label="Copies"] li')).toHaveCount(2)
  // One state per copy: its latest receipt and time, else its state (an unknown session shows its id).
  await expect(copies.locator('ul.home-copies[aria-label="Copies"] li').first()).toHaveText(/^ses_y · presented \d{1,2}:\d{2}/)
  await expect(copies.locator('ul.home-copies[aria-label="Copies"] li').nth(1)).toHaveText("ses_z · admitted")
  if (shots) await copies.screenshot({ path: path.join(shots, "life_copies.png") })
  // Off: the card is unchanged.
  await page.evaluate(() => localStorage.setItem("es-app:brief-v1", "off"))
  await page.goto(`${preview.url}/?item=attention%3Afixture%3Adecision_1`, { waitUntil: "domcontentloaded" })
  await expect(card).toBeVisible()
  await expect(card.locator(".brief-v1")).toHaveCount(0)
  expect(errors).toEqual([])
  console.log("brief-descent: PASS")
} finally {
  await browser.close()
  await preview.close()
}

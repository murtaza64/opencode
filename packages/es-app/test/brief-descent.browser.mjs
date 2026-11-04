import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
preview.ledger.operator = true
preview.fixture.permissions = []
preview.ledger.cloudLanes = []
preview.ledger.records = [{ ...preview.ledger.records[0], editspace: "fixture", lane: "upgrade-harvest-lead",
  title: "Post the owners' question in #pd-bee?", recommendation: "draft", options: [{ id: "draft", label: "Draft it in Slack" }, { id: "hold", label: "Not now" }],
  brief: { thing: "response-tagging-backend · stage check", happened: "stage runs 0 replicas; the check needs 1", key: "Nothing changes until an owner says yes",
    action: { verb: "post", to: { slack: "#pd-bee" }, as: "You", text: "Can we scale stage to 1?" },
    options: { draft: { consequence: "Opens #pd-bee with this drafted" } } } }]
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
  // Off: the card is unchanged.
  await page.evaluate(() => localStorage.setItem("es-app:brief-v1", "off"))
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(card).toBeVisible()
  await expect(card.locator(".brief-v1")).toHaveCount(0)
  expect(errors).toEqual([])
  console.log("brief-descent: PASS")
} finally {
  await browser.close()
  await preview.close()
}

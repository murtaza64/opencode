// Review items (ATTN-15): an open review is a "Try" row in Needs you; its view leads with the artifact link and
// revision, the context as what to check, and Done plus the problem option. Opening the link writes nothing and
// leaves it open; Done answers it. No brief is shown for it. Also checked at 390px wide in RTL.
// Disposable fixture. Run from packages/es-app: node test/review-item.browser.mjs
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startAttentionPreview()
const artifact = { title: "Brief gallery", url: "https://gallery.example.test/", revision: "85a6db13" }
preview.ledger.operator = true
preview.ledger.records = [{ id: "review_1", editspace: "fixture", revision: 1, status: "open", kind: "review", title: "Try the brief gallery",
  context: "Open the gallery at 390px; check item rows don't wrap.", artifact,
  options: [{ id: "done", label: "Done, looks right" }, { id: "problem", label: "Found a problem", input: { kind: "text", label: "What's wrong", required: true } }],
  producer_session: "ses_a", origin_session: "ses_a", gate_key: "brief-gallery:review:85a6db13", source_ref: { session_id: "ses_a", directory },
  decision: null, delivery_state: "not-requested", created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000, snoozed_until: null }]
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
// The artifact lives elsewhere; record that it was opened, serve nothing.
const opened = []
await context.route("https://gallery.example.test/**", route => { opened.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<title>Gallery</title>" }) })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
const commands = () => preview.ledger.calls.filter(call => call.method === "POST" && call.path.endsWith("/commands"))
const band = page.locator("nav.sidebar").getByRole("region", { name: "Needs you" })
try {
  await page.goto(`${preview.url}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const row = band.getByRole("link", { name: /^Try the brief gallery\s*, ready to try/ })
  await expect(row).toBeVisible({ timeout: 120_000 })
  await expect(row.locator(".nav-kind")).toHaveText("Try")

  await row.click()
  const view = page.locator("article.home-decision[data-attention-id=review_1]")
  const link = view.getByRole("link", { name: "Brief gallery" })
  await expect(link).toHaveAttribute("href", artifact.url)
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(view.locator(".review-artifact")).toContainText("revision 85a6db13")
  await expect(view.locator(".home-request-text")).toContainText("check item rows don't wrap")
  await expect(view.getByRole("button", { name: "Done, looks right" })).toBeEnabled()
  await expect(view.getByRole("button", { name: "Found a problem" })).toBeVisible()
  // No note box, no radio list, no brief for a review.
  await expect(view.locator("textarea")).toHaveCount(0)
  await expect(view.locator("input[type=radio]")).toHaveCount(0)
  await expect(view.locator(".home-decision-question, .home-option-card")).toHaveCount(0)

  // Opening the artifact writes nothing and leaves the review open.
  const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()])
  await popup.close()
  expect(opened.length).toBe(1)
  expect(commands()).toEqual([])
  await expect(row).toBeVisible()

  // The problem option needs its text; Cancel returns to Done.
  await view.getByRole("button", { name: "Found a problem" }).click()
  await expect(view.getByRole("button", { name: "Send Found a problem" })).toBeDisabled()
  await view.getByRole("button", { name: "Cancel" }).click()

  // RTL, narrow: the link, revision and both actions stay visible and unclipped.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  for (const target of [link, view.getByRole("button", { name: "Done, looks right" }), view.getByRole("button", { name: "Found a problem" })]) {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (!box || box.x < 0 || box.x + box.width > 390) throw new Error(`clipped at 390px RTL: ${JSON.stringify(box)}`)
  }
  await page.screenshot({ path: "/tmp/review-item-rtl-390.png" })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.setViewportSize({ width: 1280, height: 900 })

  // Done answers it with the done option only, and it leaves Needs you.
  await view.getByRole("button", { name: "Done, looks right" }).click()
  await expect.poll(() => commands().length).toBe(1)
  expect(commands()[0].body).toMatchObject({ action: "answer", choice_id: "done" })
  expect(commands()[0].body.text).toBeUndefined()
  await expect(row).toHaveCount(0)
  expect(errors).toEqual([])
  console.log("review-item: PASS")
} finally {
  await browser.close()
  await preview.close()
}

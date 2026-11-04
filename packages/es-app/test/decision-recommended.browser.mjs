// Recommended radio options (five or more) stay draft-only with the note behind "Add a note". Direct options instead
// answer on click; text-only replies open with "Type something…". A recommended secret option is a button that never
// starts open. Review controls stay unchanged.
// Run from packages/es-app: node test/decision-recommended.browser.mjs
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { startAttentionPreview } from "./attention-preview.mjs"
import path from "node:path"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const base = preview.ledger.records[0]
const record = (id, fields) => ({ ...base, id, gate_key: `fixture:${id}:v1`, created_at: Date.now() - 1000, updated_at: Date.now() - 1000, ...fields })
// Five options keep the radio/preselection behavior under test without changing the two-option preview record.
const radioOptions = [...base.options, { id: "expand", label: "Expand" }, { id: "review", label: "Review" }, { id: "pause", label: "Pause" }]
preview.ledger.records.push(
  record("recommended_radio", { title: "Pick the recommended scope", options: radioOptions }),
  record("plain", { title: "Pick a rollout window", options: [{ id: "am", label: "Morning" }, { id: "pm", label: "Evening" }], recommendation: null }),
  record("secret_rec", { title: "Rotate the deploy token", options: [{ id: "rotate", label: "Rotate now", input: { kind: "secret", label: "New token", consumer: "deploy-token", handle: "fixture-secret-rotate", fields: [{ id: "token", label: "Token" }] } }, { id: "later", label: "Later" }], recommendation: "rotate" }),
  record("try_it", { kind: "review", title: "Try the new search", artifact: { title: "Search preview", url: "http://127.0.0.1:1/preview", revision: "3" }, options: [{ id: "done", label: "Done" }, { id: "problem", label: "Report a problem", input: { kind: "text", label: "What went wrong" } }], recommendation: null }),
)
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
let failed = false
const open = async (key, viewport = { width: 1440, height: 1000 }) => {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(() => localStorage.setItem("es-app-all-projects", "true"))
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const commands = []
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/commands")) commands.push(JSON.parse(request.postData() ?? "{}")) })
  await page.goto(`${preview.url}/?item=${encodeURIComponent(`attention:fixture:${key}`)}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  return { context, page, commands }
}
try {
  for (const [name, rtl] of [["ltr", false], ["rtl", true]]) {
    const { context, page, commands } = await open("recommended_radio")
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
    const card = page.locator('[data-attention-id="recommended_radio"]')
    // Preselected as a draft and marked; the note waits behind one control.
    await expect(card.getByRole("radio", { name: "Small scope" })).toBeChecked({ timeout: 120_000 })
    await expect(card.getByRole("radio", { name: "Defer" })).not.toBeChecked()
    await expect(card.locator(".home-preselected")).toHaveCount(0)
    await expect(card.locator('[data-recommended]').first()).toBeVisible()
    await expect(card.getByRole("textbox", { name: /Note/ })).toHaveCount(0)
    await page.waitForTimeout(500)
    assert.equal(commands.length, 0, `${name}: opening sent nothing`)
    if (shots) await card.screenshot({ path: path.join(shots, `preselected-${name}.png`) })
    // Keyboard: Add a note opens the note and focuses it.
    await card.getByRole("button", { name: "Add a note" }).focus()
    await page.keyboard.press("Enter")
    const note = card.getByRole("textbox", { name: /Note/ })
    await expect(note).toBeFocused()
    await note.fill("go with the small one")
    // Only the explicit Send answers, with the preselected choice and the note.
    await card.getByRole("button", { name: /Send/ }).first().click()
    await expect.poll(() => commands.length).toBe(1)
    assert.equal(commands[0].action, "answer")
    assert.equal(commands[0].choice_id, "small")
    assert.equal(commands[0].text, "go with the small one")
    console.log(`RECOMMENDED ${name}: preselected draft, marked, no send on open; Add a note by keyboard; Send carries choice + note`)
    await context.close()
    Object.assign(preview.ledger.records.find(item => item.id === "recommended_radio"), { status: "open", revision: 1, answer: null, delivery_state: "not-requested" })
  }
  // Choosing another option shows the note inline.
  {
    const { context, page } = await open("recommended_radio")
    const card = page.locator('[data-attention-id="recommended_radio"]')
    await card.getByRole("radio", { name: "Defer" }).check({ timeout: 120_000 })
    await expect(card.getByRole("textbox", { name: /Note/ })).toBeVisible()
    await expect(card.locator(".home-preselected")).toHaveCount(0)
    await context.close()
  }
  // No recommendation: direct buttons are neutral; text-only Send is disabled until text is entered.
  {
    const { context, page } = await open("plain")
    const card = page.locator('[data-attention-id="plain"]')
    await expect(card.getByRole("button", { name: "Morning", exact: true })).toBeVisible({ timeout: 120_000 })
    await expect(card.locator(".decision-button.home-primary")).toHaveCount(0)
    await expect(card.getByRole("button", { name: "Add a note" })).toHaveCount(0)
    await expect(card.getByRole("textbox", { name: "Your answer" })).toHaveCount(0)
    await card.getByRole("button", { name: "Type something…" }).click()
    await expect(card.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
    if (shots) await card.screenshot({ path: path.join(shots, "no-recommendation.png") })
    console.log("PLAIN: no recommendation -> neutral direct buttons, text-only Send disabled")
    await context.close()
  }
  // A recommended option that takes a secret is never preselected.
  {
    const { context, page } = await open("secret_rec")
    const card = page.locator('[data-attention-id="secret_rec"]')
    const rotate = card.getByRole("button", { name: /^Rotate now/ })
    await expect(rotate).toBeVisible({ timeout: 120_000 })
    await expect(rotate).toHaveClass(/home-primary/)
    await expect(rotate).toHaveAttribute("aria-expanded", "false")
    await expect(card.getByLabel("Token")).toHaveCount(0)
    await expect(card.locator(".home-preselected")).toHaveCount(0)
    console.log("SECRET: a secret-taking recommendation is a primary button that starts closed")
    await context.close()
  }
  // Try cards keep their controls: no preselection, no Add a note.
  {
    const { context, page } = await open("try_it", { width: 390, height: 844 })
    const card = page.locator('[data-attention-id="try_it"]')
    await expect(card).toBeVisible({ timeout: 120_000 })
    await expect(card.getByRole("button", { name: "Done" })).toBeVisible()
    await expect(card.getByRole("button", { name: "Report a problem" })).toBeVisible()
    await expect(card.locator(".home-preselected, .home-add-note")).toHaveCount(0)
    console.log("TRY: unchanged controls at 390")
    await context.close()
  }
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await preview.close()
}
if (failed) process.exit(1)
console.log("PASS decision-recommended")

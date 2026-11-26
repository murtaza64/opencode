// simple-decision-direct-buttons-20261103: a plain either/or (2-4 options, none taking input) is answered by clicking
// the option itself. The recommendation is styled primary but never sent on its own; Type something… opens the one
// text path (a text-only answer, Esc keeps the draft); one click sends once; a lost response retries the same command. An option
// that takes input is a button too: its click opens the field under the buttons with Send (Save for a secret) beside it,
// and Esc or a second click folds it. Five or more options keep radio + Send. Keyboard, RTL and touch size at 390. Synthetic ledger.
// Run from packages/es-app: node test/decision-direct.browser.mjs [--shots <dir>]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startAttentionPreview } from "./attention-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startAttentionPreview()
const base = preview.ledger.records[0]
const record = (id, fields) => ({ ...base, id, gate_key: `fixture:${id}:v1`, created_at: Date.now() - 1000, updated_at: Date.now() - 1000, ...fields })
const PHONE = [{ id: "plugged", label: "Phone plugged in" }, { id: "later", label: "Later" }]
preview.ledger.records.push(
  record("phone", { kind: "blocker", title: "Plug the phone in to install Desk 0.1.42", options: PHONE, recommendation: "plugged" }),
  record("twice", { title: "Restart tonight?", options: [{ id: "yes", label: "Restart tonight" }, { id: "no", label: "Not tonight" }], recommendation: null }),
  record("lost", { title: "Keep the canary?", options: [{ id: "keep", label: "Keep" }, { id: "drop", label: "Drop" }, { id: "wait", label: "Decide Friday" }], recommendation: "keep" }),
  ...["keys_ltr", "keys_rtl"].map(id => record(id, { title: "Pick a rollout window", options: [{ id: "am", label: "Morning" }, { id: "pm", label: "Evening" }], recommendation: null })),
  record("multi", { title: "Which lanes get the summary?", options: [{ id: "send", label: "Send to", input: { kind: "multi", label: "Lanes", choices: [{ id: "a", label: "Docs" }, { id: "b", label: "Release" }] } }, { id: "none", label: "Nobody" }], recommendation: null }),
  record("secret", { title: "Provide the deploy token", options: [{ id: "give", label: "Provide it", input: { kind: "secret", label: "Token", consumer: "deploy-token", handle: "fixture-secret", fields: [{ id: "token", label: "Token" }] } }, { id: "cant", label: "I can't" }], recommendation: null }),
  record("five", { title: "Pick a theme", options: ["Mocha", "Latte", "Frappe", "Macchiato", "Plain"].map(label => ({ id: label.toLowerCase(), label })), recommendation: null }),
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
  const card = page.locator(`[data-attention-id="${key}"]`)
  await expect(card).toBeVisible({ timeout: 120_000 })
  return { context, page, commands, card }
}
try {
  {
    // Two buttons with the exact labels, the recommendation primary; no radio, no Send; opening sends nothing.
    const { context, page, commands, card } = await open("phone")
    await expect(card.getByRole("button", { name: /^Phone plugged in/ })).toHaveClass(/home-primary/)
    await expect(card.getByRole("button", { name: /^Later/ })).not.toHaveClass(/home-primary/)
    await expect(card.getByRole("radio")).toHaveCount(0)
    await expect(card.getByRole("button", { name: /^Send/ })).toHaveCount(0)
    await expect(card.locator(".home-preselected")).toHaveCount(0)
    await page.waitForTimeout(500)
    assert.equal(commands.length, 0, "opening sent nothing")
    if (shots) await card.screenshot({ path: path.join(shots, "direct-desktop.png") })
    // Type something… opens a reply field (focused); its Send answers with text only, never the recommended option.
    await expect(card.getByRole("textbox")).toHaveCount(0)
    await card.getByRole("button", { name: "Type something…" }).click()
    const reply = card.getByRole("textbox", { name: "Your answer" })
    await expect(reply).toBeFocused()
    await expect(card.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
    await reply.fill("plugged into the laptop")
    // Esc folds it back to its control and keeps the draft.
    await page.keyboard.press("Escape")
    await expect(card.getByRole("textbox")).toHaveCount(0)
    await expect(card.getByRole("button", { name: "Type something…" })).toBeFocused()
    await card.getByRole("button", { name: "Type something…" }).click()
    await expect(reply).toHaveValue("plugged into the laptop")
    if (shots) await card.screenshot({ path: path.join(shots, "direct-typing.png") })
    await card.getByRole("button", { name: "Send", exact: true }).click()
    await expect.poll(() => commands.length).toBe(1)
    assert.deepEqual({ ...commands[0], command_id: "id" }, { action: "answer", text: "plugged into the laptop", expected_revision: 1, command_id: "id" })
    await context.close()
  }
  {
    // A double click sends once.
    const { context, page, commands, card } = await open("twice")
    await card.getByRole("button", { name: /^Restart tonight/ }).dblclick()
    await expect.poll(() => commands.length).toBe(1)
    await page.waitForTimeout(800)
    assert.equal(commands.length, 1, "double click sent once")
    assert.equal(commands[0].choice_id, "yes")
    await context.close()
  }
  {
    // A lost response leaves every option disabled; the retry repeats the same command.
    const { context, page, commands, card } = await open("lost")
    let drop = true
    await context.route("**/es/api/attention/*/commands?*", async route => {
      const response = await route.fetch()
      if (drop && response.status() === 200) { drop = false; await route.abort("failed"); return }
      await route.fulfill({ response })
    })
    await card.getByRole("button", { name: /^Drop/ }).click()
    await expect(page.locator(".home-notice")).toContainText("Outcome unknown")
    for (const name of [/^Keep/, /^Drop/, /^Decide Friday/]) await expect(card.getByRole("button", { name })).toBeDisabled()
    await page.getByRole("button", { name: "Retry same action", exact: true }).click()
    await expect(page.locator(".home-notice")).toContainText("Answer saved")
    assert.equal(commands.length, 2)
    assert.equal(commands[1].command_id, commands[0].command_id, "retry reuses the command id")
    assert.equal(commands[1].choice_id, "drop")
    await context.close()
  }
  for (const rtl of [false, true]) {
    // Keyboard and touch: Tab moves across the options and Type something…, Enter answers; 44px targets at 390, RTL.
    const { context, page, commands, card } = await open(rtl ? "keys_rtl" : "keys_ltr", { width: 390, height: 844 })
    if (rtl) await page.evaluate(() => { document.documentElement.dir = "rtl" })
    const morning = card.getByRole("button", { name: /^Morning/ })
    const evening = card.getByRole("button", { name: /^Evening/ })
    assert.ok((await morning.boundingBox()).height >= 44, "touch target at least 44px")
    await morning.focus()
    await page.keyboard.press("Tab")
    await expect(evening).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(card.getByRole("button", { name: "Type something…" })).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    if (shots && rtl) await card.screenshot({ path: path.join(shots, "direct-rtl-390.png") })
    if (!rtl) {
      await page.keyboard.press("Enter")
      await expect.poll(() => commands.length).toBe(1)
      assert.equal(commands[0].choice_id, "pm")
    }
    await context.close()
  }
  {
    // An input option opens its field in place; its button becomes Send and sends the value with the choice once.
    const { context, page, commands, card } = await open("multi")
    await expect(card.getByRole("radio")).toHaveCount(0)
    await expect(card.locator(".home-preselected")).toHaveCount(0)
    const sendTo = card.getByRole("button", { name: "Send to", exact: true })
    await sendTo.click()
    await expect(card.getByRole("checkbox", { name: "Docs" })).toBeVisible()
    // The option keeps its label, pressed; the field's own Send sits beside it and the free-text row hides.
    await expect(sendTo).toHaveAttribute("aria-expanded", "true")
    await expect(card.getByRole("button", { name: "Type something…" })).toHaveCount(0)
    const send = card.getByRole("button", { name: "Send", exact: true })
    // Esc folds it back to its button, which keeps its label.
    await page.keyboard.press("Escape")
    await expect(card.getByRole("checkbox")).toHaveCount(0)
    await expect(sendTo).toBeFocused()
    await sendTo.click()
    await card.getByRole("checkbox", { name: "Release" }).check()
    await send.dblclick()
    await expect.poll(() => commands.length).toBe(1)
    await page.waitForTimeout(800)
    assert.equal(commands.length, 1, "double click sent once")
    assert.equal(commands[0].choice_id, "send")
    assert.deepEqual(commands[0].input_value, ["b"])
    await context.close()
  }
  {
    // A secret option opens the sealed field and its button becomes Save; the other button collapses it and answers.
    const { context, commands, card } = await open("secret")
    await expect(card.getByRole("radio")).toHaveCount(0)
    await card.getByRole("button", { name: "Provide it", exact: true }).click()
    await expect(card.getByLabel("Token")).toHaveAttribute("type", "password")
    await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await expect(card.getByRole("button", { name: "Submit securely" })).toHaveCount(0)
    await card.getByRole("button", { name: "I can't", exact: true }).click()
    await expect(card.getByLabel("Token")).toHaveCount(0)
    await expect.poll(() => commands.length).toBe(1)
    assert.equal(commands[0].choice_id, "cant")
    await context.close()
  }
  {
    // Five or more options keep radio + Send.
    const { context, card } = await open("five")
    await expect(card.getByRole("radio").first()).toBeVisible()
    await expect(card.locator(".decision-buttons")).toHaveCount(0)
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
console.log("PASS decision-direct")

// Composer footer (human #404) and contextual primary action (human #412).
// Footer: [model button] [ctx] [cost] [Send]; the model name is the picker button with a small glyph,
// ctx is a percent of the selected model's known window, cost is an estimate or unknown, never $0.
// Primary (button and Cmd/Ctrl+Enter, one resolver): text or images send as before; an empty draft with
// a Core-confirmed pending steer interrupts and delivers it; an empty draft with nothing pending nudges.
// Send is content-sized and keeps its inline-end edge whichever label it shows, LTR and RTL.
// Run from packages/es-app: node test/composer-footer.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-composer-footer")
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.interruptInput = true
fixture.status = "busy"
// The latest completed turn used 150k tokens; the fixture model has a 200k window; the session cost is recorded.
fixture.messages[1].info.time.completed = 3
fixture.messages[1].info.tokens = { input: 140_000, output: 6_000, reasoning: 4_000, cache: { read: 0, write: 0 } }
fixture.messages[1].info.cost = 12.5
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  for (const dir of ["ltr", "rtl"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    if (dir === "rtl") await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl" }))
    await context.route("**/config/providers*", async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.providers[0].models.test.limit = { context: 200_000 }
      await route.fulfill({ response, json: body })
    })
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    fixture.receipts.splice(0)
    await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
    const box = page.locator(".prompt-box:not([inert])")
    const editor = box.getByRole("textbox", { name: "Message", exact: true })
    const primary = box.locator(".direct-primary")
    const model = box.locator(".composer-model")
    await expect(editor).toBeVisible()

    // Footer meta: model name button with glyph, no visible "Change model" text; ctx percent; cost estimate.
    await expect(model).toHaveAccessibleName("Change model, current Fixture model")
    await expect(model.locator(".direct-model-name")).toHaveText("Fixture model")
    await expect(model.locator("svg.glyph")).toHaveCount(1)
    await expect(box.getByText("Change model", { exact: true })).toHaveCount(0)
    await expect(model).toHaveAttribute("title", /fixture · test/)
    await expect(box.locator(".composer-ctx")).toHaveText("75%")
    await expect(box.locator(".composer-ctx")).toHaveAttribute("data-level", "warn")
    await expect(box.locator(".composer-ctx")).toHaveAttribute("title", "Context used by the latest turn: 150k of 200k (Fixture model)")
    await expect(box.locator(".composer-cost")).toHaveText("~$12.50")
    await expect(box.locator(".composer-cost")).toHaveAttribute("data-decade", "2")
    // Order in reading direction: model, ctx, cost, Send.
    const x = async (locator) => (await locator.boundingBox()).x
    const order = [await x(model), await x(box.locator(".composer-ctx")), await x(box.locator(".composer-cost")), await x(primary)]
    const sorted = [...order].sort((a, b) => dir === "ltr" ? a - b : b - a)
    expect(order).toEqual(sorted)

    // Keyboard: the model button opens the picker; Escape closes it and returns focus to the button. The draft is untouched.
    await editor.fill("keep this draft")
    await editor.evaluate((el) => el.setSelectionRange(2, 6))
    await model.focus()
    await page.keyboard.press("Enter")
    const select = box.getByRole("combobox", { name: "Session model" })
    await expect(select).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(select).toHaveCount(0)
    await expect(model).toBeFocused()
    await expect(editor).toHaveValue("keep this draft")
    expect(await editor.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([2, 6])

    // With text, the busy primary is the keyboard target (Steer) as before.
    await expect(primary).toHaveAccessibleName("Steer")
    // Send is content-sized; what stays put is its inline-end edge (right in LTR, left in RTL).
    const geometry = async () => { const rect = await primary.boundingBox(); return dir === "rtl" ? Math.round(rect.x) : Math.round(rect.x + rect.width) }
    const sendGeometry = await geometry()

    // Empty draft, nothing pending: Nudge, unavailable until Core ships explicit continuation (no no-op, no
    // synthesized prompt); the chord hint hides with its space kept; Send keeps its place and width.
    await editor.fill("")
    await expect(primary).toHaveAccessibleName("Nudge the agent (empty message)")
    await expect(primary.locator("[data-current]")).toHaveText("Nudge")
    await expect(primary).toBeDisabled()
    await expect(primary).toHaveAttribute("title", /not available on this agent runtime/)
    await expect(primary.locator("kbd")).toHaveCSS("visibility", "hidden")
    expect(await geometry()).toEqual(sendGeometry)
    const nudgeCalls = fixture.calls.length
    await editor.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter")
    await page.waitForTimeout(300)
    expect(fixture.calls.slice(nudgeCalls).filter((call) => call.method === "POST")).toEqual([])
    // Whitespace is not content.
    await editor.fill("   ")
    await expect(primary).toHaveAccessibleName("Nudge the agent (empty message)")
    await editor.fill("")

    // Empty draft with a confirmed pending steer: Interrupt & steer now; Cmd+Enter delivers that steer once, no prompt or abort.
    fixture.receipts.push({ requestID: "in-steer", sessionID: "ses_a", delivery: "steer", text: "use the smaller build", agent: "build",
      admittedSeq: 1, timeCreated: Date.now(), state: "pending" })
    fixture.receipts.push({ requestID: "in-mail", sessionID: "ses_a", delivery: "steer", text: "agent mail", agent: "build",
      admittedSeq: 0, timeCreated: Date.now(), state: "pending", source: { type: "editspace-mail", id: "m1", sender: "relay", recipient: "lane" } })
    fixture.emit("session.input.admitted", { sessionID: "ses_a", requestID: "in-steer" })
    await expect(primary).toHaveAccessibleName("Interrupt & steer now with your pending steer", { timeout: 15_000 })
    expect(await geometry()).toEqual(sendGeometry)
    await page.screenshot({ path: join(shots, `interrupt-${dir}.png`) })
    const before = fixture.calls.length
    await editor.focus()
    await editor.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter")
    await expect.poll(() => fixture.calls.slice(before).filter((call) => call.method === "POST" && call.path.endsWith("/deliver")).map((call) => call.path))
      .toEqual(["/session/ses_a/input/in-steer/deliver"])
    expect(fixture.calls.slice(before).filter((call) => call.method === "POST" && /\/(abort|prompt_async|recover)$|\/input$/.test(call.path))).toEqual([])

    // Content wins again: typing restores the send action without touching the pending queue.
    await editor.fill("new words")
    await expect(primary).toHaveAccessibleName("Steer")
    expect(await geometry()).toEqual(sendGeometry)
    await page.screenshot({ path: join(shots, `footer-${dir}.png`) })

    // Narrow: the meta group wraps above Send and never overlaps it.
    await page.setViewportSize({ width: 600, height: 900 })
    const meta = await box.locator(".composer-meta").boundingBox()
    const send = await primary.boundingBox()
    expect(meta.y + meta.height <= send.y + 1 || meta.x + meta.width <= send.x + 1 || send.x + send.width <= meta.x + 1).toBe(true)
    await page.screenshot({ path: join(shots, `narrow-${dir}.png`) })
    await context.close()
  }

  // Unknown cost is shown as unknown, never $0.
  fixture.messages[1].info.cost = undefined
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const cost = page.locator(".prompt-box:not([inert]) .composer-cost")
  await expect(cost).toHaveText("~$?")
  await expect(cost).toHaveAttribute("title", "Session cost unknown: no reply has reported a cost yet.")
  await context.close()
  expect(errors).toEqual([])
  console.log(`PASS composer footer: model button + glyph (no Change model text), ctx %, cost estimate/unknown, picker focus return, primary Send/Nudge(unavailable)/Interrupt & steer now with one resolver, Cmd/Ctrl+Enter delivers once, Send inline-end edge fixed, narrow wrap, LTR/RTL; screenshots ${shots}`)
} finally {
  await browser.close()
  await preview.close()
}

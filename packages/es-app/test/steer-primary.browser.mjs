// Steer is the one send (composer-steer-primary-20261103). While the agent works, the primary button and Cmd/Ctrl+Enter
// steer, whatever target a session saved before; Queue ("Queue for when idle") and Aside ("Ask aside") are reachable
// only from More send options (mouse and keyboard). An input queued before the change keeps rendering with its Edit
// and Cancel. RTL keeps the menu usable.
// Run from packages/es-app: node test/steer-primary.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-steer-primary")
mkdirSync(shots, { recursive: true })
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "busy"
fixture.updateInput = true
// Queued before the change.
fixture.receipts.push({ requestID: "q-old", sessionID: "ses_a", delivery: "queue", text: "afterwards, update the changelog",
  agent: "build", admittedSeq: 1, timeCreated: Date.now() - 60_000, state: "pending" })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const inputs = () => fixture.calls.filter((call) => call.method === "POST" && call.path === "/session/ses_a/input")
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // A session whose saved keyboard target was Queue (the old Cmd+M cycle).
  await context.addInitScript(({ key }) => {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null")
    if (!saved) localStorage.setItem(key, JSON.stringify({ directView: 1, keyboardTarget: "queue" }))
  }, { key: `es-app:composer:1:${JSON.stringify(["ses_a", directory])}` })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  const primary = page.locator(".prompt-box .direct-primary")
  const more = page.getByRole("button", { name: "More send options", exact: true })
  await editor.waitFor({ timeout: 120_000 })

  // The old queued input renders with Edit and Cancel.
  const old = page.locator('.outgoing li[data-request-id="q-old"]')
  await expect(old.locator(".outgoing-cue > span")).toHaveText("Queued · after this task")
  await expect(old.getByRole("button", { name: /^Edit queue input/ })).toBeVisible()
  await expect(old.getByRole("button", { name: /^Cancel queue input/ })).toBeVisible()

  // Primary is Steer while busy, even with a saved Queue target; no Queue or Aside button outside the menu.
  await editor.fill("only rebuild es-app")
  await expect(primary).toHaveAccessibleName("Steer")
  await expect(page.getByRole("button", { name: /^(Queue|Aside|Queue for when idle|Ask aside)$/ })).toHaveCount(0)
  await editor.press("Meta+Enter")
  await expect.poll(() => inputs().length).toBe(1)
  expect(inputs()[0].body.delivery).toBe("steer")

  // Queue only from the menu, by keyboard.
  await editor.fill("then run the full suite")
  await more.focus()
  await page.keyboard.press("Enter")
  const queue = page.getByRole("button", { name: "Queue for when idle", exact: true })
  const aside = page.getByRole("button", { name: "Ask aside", exact: true })
  await expect(queue).toBeVisible()
  await expect(aside).toBeVisible()
  await page.screenshot({ path: join(shots, "menu.png") })
  await queue.focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => inputs().length).toBe(2)
  expect(inputs()[1].body.delivery).toBe("queue")
  await expect(queue).toHaveCount(0)
  // The old queued input is untouched: never resent or cancelled.
  await expect(old).toHaveCount(1)
  expect(inputs().filter((call) => call.body.requestID === "q-old")).toEqual([])
  expect(fixture.calls.filter((call) => call.method === "DELETE")).toEqual([])

  // Idle: the primary is Send (a steer that starts a turn); the menu is not offered.
  fixture.setStatus("idle")
  await editor.fill("idle message")
  await expect(primary).toHaveAccessibleName("Send")
  // Idle: the menu button is laid out (so Send does not move) but disabled and hidden from assistive tech.
  await expect(page.locator(".prompt-box .direct-more")).toBeDisabled()

  // RTL: the menu opens and lists both secondary choices.
  fixture.setStatus("busy")
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await more.click()
  await expect(queue).toBeVisible()
  await expect(aside).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(shots, "rtl.png") })
  await page.keyboard.press("Escape")
  expect(errors).toEqual([])
  console.log(`PASS steer primary: busy primary and Cmd+Enter steer even with a saved Queue target; Queue for when idle and Ask aside only in More send options (keyboard); old queued input keeps Edit/Cancel, never resent or cancelled; idle Send; RTL; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}

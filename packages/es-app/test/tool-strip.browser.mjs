// Live tool strip (CHAT-23, CHAT-26). From the first running call of a live turn on, consecutive calls share one strip
// that grows in place (earlier finished calls stay single chips): one focusable icon per call with a command-aware glyph, counts in words, a compact card on hover and
// keyboard focus (duration, labelled sizes, description only if present, never the command), the full call on
// Enter/click, Escape back. Calls finishing keep the strip (no regrouping while live).
// Run from packages/es-app: node test/tool-strip.browser.mjs   (SCREENSHOT_DIR=<dir>)
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "es-app-tool-strip")
mkdirSync(shots, { recursive: true })
const preview = await startToolRunsPreview(0)
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(15_000)
  await page.context().route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  page.on("pageerror", (error) => errors.push(error.message))
  fixture.status = "busy"
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  const emitPart = (part) => fixture.emit("message.part.updated", { part: { ...part, messageID: "msg_1011", sessionID: "ses_a" } })
  const strip = page.locator('.tool-strip[data-tool-strip="p63_lc"]')
  const chip = (id) => page.locator(`.tool-chip[data-timeline-part-id="${id}"]`)
  const call = (id) => strip.locator(`.tool-strip-call[data-timeline-part-id="${id}"] > .tool-chip-summary`)
  const icons = () => strip.locator(".tool-run-icon").evaluateAll((items) => items.map((item) => [item.dataset.tool, item.dataset.status]))
  const glyph = (id) => call(id).locator(".tool-run-icon use").getAttribute("href")

  // Two finished reads and one running shell call: single chips, no strip, no live run group.
  await expect(chip("p63_lc").locator(".tool-chip-state")).toHaveText("running · sleep 1", { timeout: 60_000 })
  await expect(page.locator(".tool-strip")).toHaveCount(0)
  await expect(page.locator('[data-find-message="msg_1011"] .tool-run')).toHaveCount(0)
  await chip("p61_la").evaluate((element) => { element.dataset.mark = "kept" })

  // A second call starts: the strip forms from the running call on; the finished reads stay untouched chips.
  emitPart(preview.tool("p64_ld", "bash", { command: "cd repo && git status" }, "", { status: "running" }))
  await expect(strip).toHaveCount(1)
  expect(await icons()).toEqual([["bash", "unfinished"], ["bash", "unfinished"]])
  await expect(strip.locator(".tool-strip-state")).toHaveText("2 running")
  await expect(chip("p61_la")).toHaveAttribute("data-mark", "kept")
  await expect(chip("p62_lb").locator(".tool-strip-call")).toHaveCount(0)
  await strip.evaluate((element) => { element.dataset.mark = "same" })
  // More calls start: the same strip grows; glyphs follow what each command runs.
  emitPart(preview.tool("p65_le", "bash", { command: "bun test src/a.test.ts", description: "Unit tests" }, "", { status: "running" }))
  await expect(strip.locator(".tool-run-icon")).toHaveCount(3)
  await expect(strip).toHaveAttribute("data-mark", "same")
  await expect(strip.locator(".tool-strip-state")).toHaveText("3 running")
  await expect(strip.locator(".tool-run-count")).toHaveText("3 calls")
  expect(await glyph("p64_ld")).toMatch(/branch/)
  expect(await glyph("p65_le")).toMatch(/circle-check/)
  expect(await glyph("p63_lc")).toMatch(/console/)

  // Hover: the compact card, with description, time so far and labelled sizes; never the command.
  await call("p65_le").hover()
  const card = call("p65_le").locator(".tool-call-card")
  await expect(card).toBeVisible()
  await expect(card.locator(".tool-run-kind")).toHaveText(/ · running$/)
  await expect(card.locator(".tool-call-description")).toHaveText("Unit tests")
  await expect(card.locator(".tool-run-span")).toHaveText(/ so far$/)
  await expect(card.locator(".tool-run-sizes")).toHaveText(/^input \d+ chars · output pending$/)
  expect(await card.textContent()).not.toContain("bun test")
  // No description line when the call has none.
  await call("p64_ld").hover()
  await expect(call("p64_ld").locator(".tool-call-description")).toHaveCount(0)
  await page.screenshot({ path: join(shots, "hover.png") })
  await page.mouse.move(0, 0)

  // Keyboard: one tab stop; arrows and Home/End move; focus shows the same card; Enter opens, Escape returns.
  expect(await strip.locator('.tool-strip-call > button[tabindex="0"]').count()).toBe(1)
  await call("p63_lc").focus()
  await page.keyboard.press("ArrowRight")
  await expect(call("p64_ld")).toBeFocused()
  await page.keyboard.press("End")
  await expect(call("p65_le")).toBeFocused()
  await expect(call("p65_le").locator(".tool-call-card")).toBeVisible()
  await expect(call("p65_le")).toHaveAccessibleName(/^Shell · running, Unit tests, .* so far, input \d+ chars · output pending$/)
  expect(await strip.locator('.tool-strip-call > button[tabindex="0"]').count()).toBe(1)
  await page.keyboard.press("Enter")
  const member = strip.locator('[data-tool-strip-member="p65_le"]')
  await expect(call("p65_le")).toHaveAttribute("aria-expanded", "true")
  // The full command is shown only in the opened call.
  await expect(member).toContainText("bun test src/a.test.ts")
  await page.keyboard.press("Escape")
  await expect(member).toHaveCount(0)
  await expect(call("p65_le")).toBeFocused()
  await page.keyboard.press("Home")
  await expect(call("p63_lc")).toBeFocused()

  // Calls finish: the strip stays (no regrouping while live) and its words follow.
  emitPart(preview.tool("p63_lc", "bash", { command: "sleep 1" }, "done", { metadata: { exit: 0 }, end: 900 }))
  emitPart(preview.tool("p64_ld", "bash", { command: "cd repo && git status" }, "clean", { metadata: { exit: 0 }, end: 400 }))
  await expect(strip.locator(".tool-strip-state")).toHaveText("1 running")
  emitPart(preview.tool("p65_le", "bash", { command: "bun test src/a.test.ts", description: "Unit tests" }, "1 fail", { metadata: { exit: 1 }, end: 3_010 }))
  await expect(strip.locator(".tool-strip-state")).toHaveText("1 failed")
  await expect(strip).toHaveAttribute("data-mark", "same")
  expect(await icons()).toEqual([["bash", "ok"], ["bash", "ok"], ["bash", "failed"]])
  // A finished call: actual duration and both sizes with units.
  await call("p64_ld").hover()
  await expect(call("p64_ld").locator(".tool-run-span")).toHaveText("390ms")
  await expect(call("p64_ld").locator(".tool-run-sizes")).toHaveText(/^input \d+ chars · output \d+ chars$/)
  await call("p65_le").hover()
  await expect(call("p65_le").locator(".tool-run-kind")).toHaveText(/ · failed$/)
  await expect(call("p65_le").locator(".tool-run-span")).toHaveText("3.0s")
  await page.mouse.move(0, 0)

  // RTL: ArrowLeft moves to the next call.
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await call("p63_lc").focus()
  await page.keyboard.press("ArrowLeft")
  await expect(call("p64_ld")).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(shots, "rtl.png") })
  expect(errors).toEqual([])
  console.log(`PASS tool strip: from the first running call, live consecutive calls share one strip (earlier finished chips untouched) that grows in place and stays as calls finish; command-aware glyphs; counts in words; compact card on hover and focus (description, duration, labelled sizes, no command); one tab stop with arrows/Home/End (RTL-aware); Enter opens the full call, Escape returns; screenshots ${shots}`)
} finally {
  await preview.close()
  await browser.close()
}

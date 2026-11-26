// Reasoning chips and the turn footer (Laptop .04.3). Reasoning is one collapsed chip per Core part, in the r4
// tool/mail row; the chip is the live indicator while that part streams (never beside the composer's activity dot).
// The turn footer rides the Copy row, hidden until hover/focus/tap, except when the turn ends in a tool or nothing.
// Error states are icons in that row; a provider error is one cause line plus Details. Fixtures only; no live failure.
// Run from packages/es-app: node test/reasoning-chips.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const at = Date.UTC(2026, 10, 5, 12, 0, 0)
const base = (id, role, parentID, created, completed, extra = {}) => ({
  info: { id, parentID, sessionID: "ses_a", role, agent: "implement", mode: "implement", providerID: "fixture", modelID: "test",
    path: { cwd: directory, root: directory }, time: { created, ...(completed === undefined ? {} : { completed }) }, cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra },
  parts: [],
})
const text = (id, messageID, value, time) => ({ id, messageID, sessionID: "ses_a", type: "text", text: value, time })
const reasoning = (id, messageID, value, time) => ({ id, messageID, sessionID: "ses_a", type: "reasoning", text: value, time })
const user = (id, created, value) => ({ info: { id, sessionID: "ses_a", role: "user", agent: "implement", model: { providerID: "fixture", modelID: "test" }, time: { created } },
  parts: [text(`${id}_t`, id, value, { start: created, end: created }) ] })
const tool = (id, messageID, created) => ({ id, messageID, sessionID: "ses_a", type: "tool", tool: "bash", callID: `call_${id}`,
  state: { status: "completed", input: { command: "ls" }, output: "ok", title: "", metadata: { exit: 0 }, time: { start: created, end: created + 100 } } })

// A text-ending turn with two reasoning blocks (one empty), a tool between them, and a final text.
const first = base("msg_1a", "assistant", "msg_1u", at + 1_000, at + 9_000)
first.parts = [
  reasoning("prt_r1", first.info.id, "## First thought\n\nThe parser only reads the header.", { start: at + 1_000, end: at + 2_000 }),
  text("prt_t1", first.info.id, "First answer.", { start: at + 2_100, end: at + 2_500 }),
  reasoning("prt_r2", first.info.id, "   ", { start: at + 2_600, end: at + 2_700 }),
  tool("prt_tool", first.info.id, at + 3_000),
  text("prt_t2", first.info.id, "Final answer.", { start: at + 4_000, end: at + 4_500 }),
]
fixture.messages = [
  user("msg_1u", at, "Please explain the parser"),
  first,
  // A tool-only end: the footer must stay visible without a hover.
  user("msg_2u", at + 20_000, "Run it"),
  { ...base("msg_2a", "assistant", "msg_2u", at + 21_000, at + 22_000, { finish: "tool-calls" }), parts: [tool("prt_only", "msg_2a", at + 21_100)] },
  // A silent end: still a visible footer.
  user("msg_3u", at + 30_000, "Quietly finish"),
  base("msg_3a", "assistant", "msg_3u", at + 31_000, at + 31_500, { finish: "stop" }),
  // A provider error: one cause line + Details, and an error icon in the footer.
  user("msg_4u", at + 40_000, "And this"),
  base("msg_5a", "assistant", "msg_4u", at + 41_000, at + 41_500, { finish: "error", error: { name: "APIError", data: { message: "Usage limit has been reached", statusCode: 429 } } }),
  // A cancelled end (settled without completion): no success mark, a cancelled icon.
  user("msg_6u", at + 50_000, "Stop here"),
  base("msg_6a", "assistant", "msg_6u", at + 51_000, undefined, { finish: "stop" }),
]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const editor = page.getByRole("textbox", { name: "Message", exact: true })
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 180_000 })
  await expect(page.locator('[data-find-message="msg_1a"] .transcript, [data-find-message="msg_1a"]')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator(".reasoning-chip")).toHaveCount(1, { timeout: 60_000 })

  // One chip for the non-empty block; none for the empty part; it sits at its part's place before the tool.
  const firstTurn = page.locator('[data-find-message="msg_1a"]')
  const chip = firstTurn.locator(".reasoning-chip")
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveClass(/tool-chip/)
  await expect(chip.locator("button")).toHaveAttribute("aria-expanded", "false")
  await expect(chip).toContainText("Reasoning")
  await expect(chip.locator(".reasoning-chip-member")).toHaveCount(0)
  const order = await firstTurn.locator(".reasoning-chip, .tool-chip[data-timeline-part-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-timeline-part-id")))
  expect(order).toEqual(["prt_r1", "prt_tool"])

  // Focus and Enter/Space toggle; the draft and caret do not change.
  await editor.fill("a draft")
  await editor.evaluate((el) => el.setSelectionRange(2, 2))
  const toggle = chip.locator("button")
  await toggle.focus()
  await toggle.press("Enter")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(chip.locator(".reasoning-chip-member")).toBeVisible()
  await expect(chip.locator(".reasoning-chip-member")).toContainText("The parser only reads the header.")
  await toggle.press("Space")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.press(" ")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(editor).toHaveValue("a draft")
  expect(await editor.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([2, 2])

  // Footer: text-ending turn hides it with the Copy row; hover reveals it; no success mark.
  const textTurn = page.locator('[data-find-message="msg_1a"]')
  const copyRow = textTurn.locator('[data-slot="text-part-copy-wrapper"]')
  await expect(copyRow.locator(".turn-summary")).toHaveCount(1)
  await expect(copyRow.locator(".turn-state")).toHaveCount(0)
  expect(await copyRow.evaluate((el) => getComputedStyle(el).opacity)).toBe("0")
  await textTurn.locator('[data-component="text-part"]').last().hover()
  await expect.poll(() => copyRow.evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
  const copy = copyRow.getByRole("button", { name: /Copy response|Copied/ })
  await expect(copy).toHaveCount(1)
  // Keyboard focus in the row reveals the same footer.
  const transcript = page.locator(".transcript")
  await transcript.hover()
  await page.mouse.wheel(0, -300)
  await page.waitForTimeout(150)
  const before = await transcript.evaluate((el) => el.scrollTop)
  await copy.focus()
  await expect.poll(() => copyRow.evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
  // Toggling a reasoning chip earlier neither collapses the footer nor scrolls the reader away; the choice returns.
  for (const restore of [false, true]) {
    await chip.locator("button").click()
    await page.waitForTimeout(150)
    expect(Math.abs((await transcript.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(4)
    if (restore) break
  }

  // A tap reveals the same row on touch (the synthesised pointer type).
  await textTurn.evaluate((el) => el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" })))
  await expect(textTurn).toHaveAttribute("data-touch-reveal", "")
  await expect.poll(() => copyRow.evaluate((el) => getComputedStyle(el).opacity)).toBe("1")

  // Tool-only and silent ends: the footer is always visible; the error/cancelled icons carry labels.
  for (const id of ["msg_2a", "msg_3a"]) {
    const footer = page.locator(`[data-find-message="${id}"] .turn-summary[data-standalone]`)
    await expect(footer).toBeVisible()
    expect(await footer.evaluate((el) => getComputedStyle(el).display)).not.toBe("none")
    await expect(footer.locator(".turn-state")).toHaveCount(0)
  }
  await expect(page.locator('[data-find-message="msg_5a"] .turn-state[data-state="error"]')).toHaveAttribute("aria-label", "Error")
  await expect(page.locator('[data-find-message="msg_6a"] .turn-state[data-state="cancelled"]')).toHaveAttribute("aria-label", "Cancelled")
  await expect(page.locator('[data-find-message="msg_5a"] .turn-summary[data-standalone]')).toBeVisible()

  // A new message re-renders the transcript; the block's choice survives.
  const next = base("msg_7a", "assistant", "msg_6u", at + 52_000, at + 53_000)
  next.parts = [text("prt_after", "msg_7a", "Later.", { start: at + 52_000, end: at + 52_500 })]
  fixture.messages.push(next)
  fixture.emit("message.updated", { info: next.info })
  fixture.emit("message.part.updated", { part: next.parts[0] })
  await expect(page.locator('[data-find-message="msg_7a"]')).toContainText("Later.", { timeout: 30_000 })
  await expect(chip.locator("button")).toHaveAttribute("aria-expanded", "true")

  // A streaming reasoning part is its own live chip; no thinking dots beside the composer.
  fixture.setStatus("busy")
  const liveInfo = { ...base("msg_8a", "assistant", "msg_6u", at + 54_000, undefined).info }
  const livePart = reasoning("prt_live", "msg_8a", "Still working through the rows.", { start: at + 54_000 })
  fixture.messages.push({ info: liveInfo, parts: [livePart] })
  fixture.emit("message.updated", { info: liveInfo })
  fixture.emit("message.part.updated", { part: livePart })
  const live = page.locator('[data-find-message="msg_8a"] .reasoning-chip')
  await expect(live).toHaveCount(1, { timeout: 30_000 })
  await expect(live).toContainText("Thinking")
  await expect(live).toHaveAttribute("data-streaming", "")
  await expect(live.locator(".reasoning-chip-member")).toHaveCount(0)
  await expect(page.locator(".session-work-status .thinking-dots")).toHaveCount(0)
  fixture.emit("message.part.updated", { part: { ...livePart, time: { start: at + 54_000, end: at + 55_000 } } })
  fixture.emit("message.updated", { info: { ...liveInfo, time: { created: at + 54_000, completed: at + 55_000 } } })
  fixture.setStatus("idle")
  await expect(live).toContainText("Reasoning")
  await expect(live).not.toHaveAttribute("data-streaming", "")

  // The provider error is one cause line plus discoverable Details; no retry/replay is invented.
  const error = page.locator(".conversation-error")
  await expect(error).toHaveCount(1)
  await expect(error.locator(".conversation-error-cause")).toHaveText("Usage limit has been reached")
  await expect(error.locator("summary")).toContainText("Details")
  await expect(error.locator(".conversation-error-detail")).toContainText("Usage limit has been reached")
  await expect(error.getByRole("button")).toHaveCount(0)

  expect(errors).toEqual([])
  console.log("PASS reasoning chips and turn footer: one collapsed chip per Core reasoning part (live only while it streams), expand/keyboard/choice persistence, text/tool/silent/error/cancelled footers, Copy row reveal by hover/tap, Details for provider errors")
} finally {
  await browser.close()
  await preview.close()
}

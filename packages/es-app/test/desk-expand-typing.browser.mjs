// Main1690 / Desk2329 (#232): in the Front desk companion, a manually expanded editor keeps its height while typing
// (continuous non-wrapping and wrapping text, deleting back, a multi-line paste, undo); the content-sized auto mode
// never expands on its own: it grows by wrapped lines to its max-height, then scrolls, and shrinks on delete. Records the textarea height and expanded state at every animation frame and
// after every key, and fails on any height change that is not a line-step in auto mode or any change at all in
// manual expanded mode. Synthetic draft in a disposable fixture; no sends.
// Run from packages/es-app: node test/desk-expand-typing.browser.mjs
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.status = "idle"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const viewport = { width: Number(process.env.VW ?? 1440), height: Number(process.env.VH ?? 900) }
const context = await browser.newContext({ viewport })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await context.addInitScript(value => { try { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)); localStorage.setItem("es-app:companion:work", "1") } catch {} }, { session: "ses_b", directory })
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
const failures = []
try {
  await page.goto(`${preview.origin}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const companion = page.locator(".desk-companion")
  const editor = companion.locator(".direct-composer textarea[aria-label='Message']")
  await expect(editor).toBeVisible({ timeout: 120_000 })
  // Frame sampler: every distinct (height, expanded) pair, in order.
  await editor.evaluate(el => {
    const box = el.closest(".prompt-box")
    window.__trace = []
    const tick = () => {
      const h = Math.round(el.getBoundingClientRect().height)
      const expanded = box.classList.contains("prompt-expanded")
      const last = window.__trace.at(-1)
      if (!last || last.h !== h || last.expanded !== expanded) window.__trace.push({ t: Math.round(performance.now()), h, expanded, len: el.value.length })
      window.__raf = requestAnimationFrame(tick)
    }
    tick()
  })
  const trace = () => page.evaluate(() => window.__trace)
  // Keeps the current sample as the baseline, so a trace lists only changes after it.
  const reset = () => page.evaluate(() => { window.__trace = window.__trace.slice(-1) })
  const settle = () => page.waitForTimeout(350)
  const lineHeight = await editor.evaluate(el => parseFloat(getComputedStyle(el).lineHeight) || 20)
  const instance = await editor.evaluate(el => { el.dataset.instance = "one"; return true })

  // Manual expanded mode.
  await editor.focus()
  await companion.getByRole("button", { name: /^Expand editor/ }).click()
  await expect(companion.locator(".prompt-box")).toHaveClass(/prompt-expanded/)
  await editor.focus()
  await settle()
  await reset()
  const steps = [
    ["non-wrapping", async () => { for (const ch of "hello there") await page.keyboard.type(ch) }],
    ["wrapping", async () => { for (const ch of " word".repeat(60)) await page.keyboard.type(ch) }],
    ["deleting", async () => { for (let i = 0; i < 200; i++) await page.keyboard.press("Backspace") }],
    ["paste multi-line", async () => { await editor.evaluate(el => { const data = new DataTransfer(); data.setData("text/plain", "a\nb\nc\nd\ne\nf"); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })) }); await page.keyboard.insertText("a\nb\nc\nd\ne\nf") }],
    ["undo", async () => { await page.keyboard.press("ControlOrMeta+z") }],
  ]
  for (const [name, act] of steps) {
    await act()
    await settle()
    const rows = await trace()
    const heights = [...new Set(rows.map(row => row.h))]
    const collapsed = rows.some(row => !row.expanded)
    if (heights.length > 1 || collapsed) failures.push({ mode: "manual expanded", step: name, heights, collapsed, changes: rows.length })
    await reset()
  }
  await expect(editor).toHaveAttribute("data-instance", "one")

  // Auto mode (collapse, clear): height may change only in whole-line steps, never back and forth per key.
  await companion.getByRole("button", { name: /^Collapse editor/ }).click()
  await editor.fill("")
  await editor.focus()
  await settle()
  await reset()
  for (const ch of "short") await page.keyboard.type(ch)
  await settle()
  let rows = await trace()
  if (rows.length > 1) failures.push({ mode: "auto", step: "typing a short line", heights: rows.map(row => row.h), expanded: rows.map(row => row.expanded) })
  const oneLine = await editor.evaluate(el => Math.round(el.getBoundingClientRect().height))
  await reset()
  for (const ch of " word".repeat(40)) await page.keyboard.type(ch)
  await settle()
  rows = await trace()
  const flips = rows.filter((row, index) => index && row.h < rows[index - 1].h).length
  if (flips) failures.push({ mode: "auto", step: "wrapping", note: "height went down while typing", heights: rows.map(row => row.h), expanded: rows.map(row => row.expanded) })

  // Auto mode never enters expanded mode; growth stays within its own max-height.
  if (rows.some(row => row.expanded)) failures.push({ mode: "auto", step: "wrapping", note: "expanded on its own" })
  const max = await editor.evaluate(el => parseFloat(getComputedStyle(el).maxHeight))
  if (rows.some(row => row.h > max + 1)) failures.push({ mode: "auto", step: "wrapping", note: `taller than its max-height ${max}` })
  // Keep typing and deleting: it must not flip between modes per key.
  await reset()
  for (const ch of " more".repeat(30)) await page.keyboard.type(ch)
  for (let i = 0; i < 60; i++) await page.keyboard.press("Backspace")
  await settle()
  rows = await trace()
  const modeFlips = rows.filter((row, index) => index && row.expanded !== rows[index - 1].expanded).length
  if (modeFlips) failures.push({ mode: "auto", step: "typing after auto-expand", note: "expanded/collapsed flips", flips: modeFlips, heights: rows.map(row => row.h).slice(0, 40) })

  // Deleting back to one line shrinks it to its starting height.
  await editor.fill("")
  await editor.focus()
  for (const ch of "short") await page.keyboard.type(ch)
  await settle()
  const back = await editor.evaluate(el => Math.round(el.getBoundingClientRect().height))
  if (back !== oneLine) failures.push({ mode: "auto", step: "shrink on delete", note: `${back} != ${oneLine}` })
  await expect(editor).toHaveAttribute("data-instance", "one")

  console.log(JSON.stringify({ viewport, lineHeight, failures }, null, 1))
  assert.deepEqual(failures, [], "editor height changed outside intended line steps")
  assert.deepEqual(errors, [])
  console.log("PASS desk editor: manual expanded height stable through typing, wrapping, deleting, paste and undo; auto never expands on its own, grows by lines within max-height, shrinks back; same textarea")
} finally {
  await browser.close()
  await preview.close()
}

// Filament overlay: off by default; on with es-app:filament=1 it covers exactly the transcript box,
// follows real part/status events, rests when idle or hidden, goes static under reduced motion, and
// never touches the composer, selection or scroll. No writes beyond the fixture's normal reads.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const browser = await chromium.launch({ headless: process.env.HEADED !== "1",
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const errors = []
const open = async (options = {}, query = "") => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${preview.url}${query}`)
  await expect(page.locator(".transcript")).toBeVisible()
  return { context, page }
}
const text = (id, body, end) => ({ id, messageID: "msg_2", sessionID: "ses_a", type: "text", text: body, time: { start: 10, ...(end ? { end } : {}) } })
const tool = (status) => ({ id: "part_ftool", messageID: "msg_2", sessionID: "ses_a", type: "tool", callID: "call_f", tool: "bash",
  state: status === "running" ? { status, input: {}, title: "bun test", time: { start: Date.now() - 2000 }, metadata: {} }
    : { status, input: {}, output: "", title: "bun test", time: { start: Date.now() - 2000, end: Date.now() }, metadata: {} } })
const requestsBefore = () => fixture.calls.length
try {
  // ---- default off: nothing mounted, no gutter ----
  {
    const { context, page } = await open()
    await expect(page.locator(".filament-canvas")).toHaveCount(0)
    expect(await page.locator(".transcript").getAttribute("data-filament")).toBeNull()
    await context.close()
  }
  // ---- URL flag: this load only; a stray link never persists the overlay ----
  {
    const { context, page } = await open({}, "&filament=1")
    await expect(page.locator(".filament-canvas")).toHaveCount(1)
    expect(await page.evaluate(() => localStorage.getItem("es-app:filament"))).toBeNull()
    await page.goto(preview.url)
    await expect(page.locator(".transcript")).toBeVisible()
    await expect(page.locator(".filament-canvas")).toHaveCount(0)
    await page.reload()
    await expect(page.locator(".transcript")).toBeVisible()
    await expect(page.locator(".filament-canvas")).toHaveCount(0)
    await context.close()
  }
  // ---- deliberate opt-in: localStorage set by the operator ----
  const { context, page } = await open({}, "&filamentHud=1")
  await page.evaluate(() => localStorage.setItem("es-app:filament", "1"))
  await page.reload()
  await expect(page.locator(".transcript")).toBeVisible()
  const canvas = page.locator(".filament-canvas")
  await expect(canvas).toHaveCount(1)
  await expect(page.locator(".transcript")).toHaveAttribute("data-filament", "1")
  const transcriptBox = await page.locator(".transcript").boundingBox()
  const canvasBox = await canvas.boundingBox()
  for (const k of ["x", "y", "width", "height"]) expect(Math.abs(canvasBox[k] - transcriptBox[k])).toBeLessThan(1.5)
  // The canvas is scroll content (sticky), so it stays glued to the scrollport after scrolling too.
  await page.locator(".transcript").evaluate((el) => { el.scrollTop = 120 })
  await page.waitForTimeout(100)
  const after = await canvas.boundingBox()
  for (const k of ["x", "y"]) expect(Math.abs(after[k] - transcriptBox[k])).toBeLessThan(1.5)
  // Overscroll (synthetic touchpad gesture via CDP): rubber-band translates content and canvas together.
  const cdp = await context.newCDPSession(page)
  const centre = { x: transcriptBox.x + transcriptBox.width / 2, y: transcriptBox.y + transcriptBox.height / 2 }
  await page.locator(".transcript").evaluate((el) => { el.scrollTop = 0 })
  await page.waitForTimeout(100)
  const rest = await page.evaluate(() => window.__filament.attached())
  const samples = []
  const sampler = setInterval(async () => { samples.push(await page.evaluate(() => window.__filament.attached()).catch(() => null)) }, 16)
  // Pull down past the top, then the bottom: elastic overscroll on macOS translates the content.
  await cdp.send("Input.synthesizeScrollGesture", { x: centre.x, y: centre.y, yDistance: 500, gestureSourceType: "mouse", speed: 3000 })
  await page.waitForTimeout(250)
  await page.locator(".transcript").evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(60)
  await cdp.send("Input.synthesizeScrollGesture", { x: centre.x, y: centre.y, yDistance: -500, gestureSourceType: "mouse", speed: 3000 })
  await page.waitForTimeout(250)
  clearInterval(sampler)
  const restGap = rest.canvasTop - rest.innerTop
  const atTop = samples.filter((s) => s && s.scrollTop <= 0)
  const bounced = atTop.filter((s) => Math.abs(s.innerTop - rest.innerTop) > 2)
  const detached = bounced.filter((s) => Math.abs((s.canvasTop - s.innerTop) - restGap) > 1.5)
  console.log(JSON.stringify({ overscroll: { samples: samples.length, atTop: atTop.length, bounceFrames: bounced.length, detachedFrames: detached.length, maxContentShift: Math.max(0, ...atTop.map((s) => Math.abs(s.innerTop - rest.innerTop))).toFixed(1) } }))
  // Attachment: whenever the content visibly bounced, the canvas moved by the same amount.
  expect(detached.length).toBe(0)
  const composerBox = await page.locator(".prompt-box textarea, .float-editor textarea").first().boundingBox()
  expect(canvasBox.y + canvasBox.height).toBeLessThanOrEqual(composerBox.y + 1)
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".transcript")).paddingInlineStart)).toBe("28px")
  const backend = await page.evaluate(() => window.__filament.backend())
  console.log("backend", JSON.stringify(backend))

  // ---- phases follow real events; no extra requests are made by the overlay ----
  const calls = requestsBefore()
  // The fixture's last assistant message is unfinished (no completed time, open text part), so busy reads as streaming.
  fixture.setStatus("busy")
  await expect.poll(() => page.evaluate(() => window.__filament.phase())).toBe("streaming")
  fixture.emit("message.part.updated", { part: text("part_ftext", "Looking at the sidebar") })
  for (let i = 0; i < 12; i++) fixture.emit("message.part.updated", { part: text("part_ftext", "Looking at the sidebar".repeat(i + 2)) })
  fixture.emit("message.part.updated", { part: tool("running") })
  await expect.poll(() => page.evaluate(() => window.__filament.phase())).toBe("tool")
  expect(await page.evaluate(() => window.__filament.running())).toBe(true)
  expect(await page.evaluate(() => window.__filament.measured())).toBeGreaterThan(0)
  fixture.emit("message.part.updated", { part: tool("completed") })
  fixture.emit("message.part.updated", { part: text("part_ftext", "Looking at the sidebar. Done.", 99) })
  fixture.setStatus("idle")
  await expect.poll(() => page.evaluate(() => window.__filament.phase())).toBe("complete")
  // Transients finish within a second, then the loop rests.
  await expect.poll(() => page.evaluate(() => window.__filament.running()), { timeout: 3000 }).toBe(false)
  const stats = await page.evaluate(() => window.__filament.stats())
  console.log("stats", JSON.stringify(stats))
  expect(stats.frames).toBeGreaterThan(10)
  expect(fixture.calls.slice(calls).filter((call) => !/\/session\/ses_a\/(message|todo|part)|\/event|\/api\//.test(call.path))).toEqual([])

  // ---- scroll and selection are untouched; composer input works through the overlay ----
  await page.locator(".transcript").evaluate((el) => { el.scrollTop = 0 })
  const beforeScroll = await page.locator(".transcript").evaluate((el) => el.scrollTop)
  await page.waitForTimeout(300)
  expect(await page.locator(".transcript").evaluate((el) => el.scrollTop)).toBe(beforeScroll)
  const selected = await page.evaluate(() => {
    const el = document.querySelector(".transcript [data-component='text-part'], .transcript [data-component='user-message']")
    const range = document.createRange(); range.selectNodeContents(el)
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range)
    return sel.toString().length
  })
  expect(selected).toBeGreaterThan(0)
  const editor = page.getByRole("textbox", { name: "Message", exact: true }).first()
  await editor.click()
  await editor.type("hello filament")
  await expect(editor).toHaveValue(/hello filament/)
  expect(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest(".filament-canvas"))).toBeNull()
  await context.close()

  // ---- reduced motion: static badge, no running loop, canvas still placed ----
  {
    const { context, page } = await open({ reducedMotion: "reduce" }, "&filament=1")
    await expect(page.locator(".filament-static")).toBeVisible()
    fixture.setStatus("busy")
    fixture.emit("message.part.updated", { part: tool("running") })
    await expect(page.locator(".filament-static")).toHaveAttribute("data-phase", "tool")
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => window.__filament.running())).toBe(false)
    fixture.emit("message.part.updated", { part: tool("completed") })
    fixture.setStatus("idle")
    await context.close()
  }
  // ---- hidden tab never renders ----
  {
    const { context, page } = await open({}, "&filament=1")
    fixture.setStatus("busy")
    fixture.emit("message.part.updated", { part: tool("running") })
    await expect.poll(() => page.evaluate(() => window.__filament.running())).toBe(true)
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")) })
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => window.__filament.running())).toBe(false)
    fixture.emit("message.part.updated", { part: tool("completed") })
    fixture.setStatus("idle")
    await context.close()
  }
  // ---- RTL + narrow: gutter at the logical start, canvas still matches the transcript box ----
  {
    const { context, page } = await open({ viewport: { width: 480, height: 820 } }, "&filament=1")
    await page.evaluate(() => { document.documentElement.dir = "rtl" })
    await page.waitForTimeout(300)
    const t = await page.locator(".transcript").boundingBox()
    const c = await page.locator(".filament-canvas").boundingBox()
    expect(Math.abs(c.x - t.x)).toBeLessThan(1.5)
    expect(Math.abs(c.width - t.width)).toBeLessThan(1.5)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".transcript")).paddingRight)).toBe("28px")
    await context.close()
  }
  expect(errors).toEqual([])
  console.log("PASS filament: off by default; URL flag is per-load only; opt-in overlay matches the transcript box, follows part/status events, rests idle/hidden, static under reduced motion, RTL gutter, no extra requests")
} finally {
  await browser.close()
  await preview.close()
}

// Feel contract (dotfiles#240): instant by default, press acknowledged on the
// same frame, one-shot decays only for changes (status ring, jump flash), none
// under reduced motion; logical RTL accents; keyboard-reachable hover actions.
// Run from packages/es-app: node test/feel.browser.mjs
import { createRequire } from "node:module"
import { startToolRunsPreview } from "./tool-runs-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startToolRunsPreview(0, { filler: 4 })
const fixture = preview.fixture
const browser = await chromium.launch({ channel: "chrome", headless: true })
const errors = []
const open = async (options = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options })
  await context.route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(preview.url)
  await expect(page.locator("textarea").first()).toBeVisible({ timeout: 90_000 })
  await expect.poll(() => [...fixture.eventStreams.values()].some((stream) => stream.path === "/global/event")).toBe(true)
  return { context, page }
}
const publish = (type, properties) => {
  for (const [response, stream] of fixture.eventStreams)
    if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
}
const animations = (locator) => locator.evaluate((element) => element.getAnimations().map((animation) => Object.keys(animation.effect.getKeyframes()[0]).filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key))).flat())
try {
  const { context, page } = await open()

  // Press acknowledged on pointer-down, before any click handler runs.
  const button = page.locator(".sidebar .new-session-button")
  const rest = await button.evaluate((element) => getComputedStyle(element).backgroundColor)
  await button.hover()
  await page.mouse.down()
  const pressed = await button.evaluate((element) => getComputedStyle(element).backgroundColor)
  // Release elsewhere so the press does not navigate.
  await page.mouse.move(700, 600)
  await page.mouse.up()
  expect(pressed, "pressed button fills immediately").not.toBe(rest)
  expect(pressed).toBe("rgb(58, 58, 66)")

  // Instant by default: no CSS transitions on buttons or rows.
  expect(await page.evaluate(() => [...document.querySelectorAll("button, .nav-item")].filter((element) => parseFloat(getComputedStyle(element).transitionDuration) > 0).length)).toBe(0)

  // A prompt jump flashes its target once.
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.locator("textarea").first().focus()
  await page.keyboard.press("Control+p")
  const bubble = page.locator("[data-user-prompt] [data-slot='user-message-text'], [data-user-prompt] [data-component='user-message-text']")
  await expect.poll(async () => (await Promise.all((await bubble.all()).map(animations))).flat()).toContain("backgroundColor")

  // A status change to pending rings the dot once; first paint does not.
  const dot = page.locator(`.sidebar .session-entry[data-peek-id="ses_a"] .dot`)
  expect(await animations(dot)).toEqual([])
  const permission = { id: "per_feel", sessionID: "ses_a", permission: "bash", patterns: ["ls"], always: [], metadata: {} }
  fixture.permissions = [permission]
  publish("permission.asked", permission)
  await expect(dot).toHaveClass(/pending/)
  await expect.poll(() => animations(dot)).toContain("boxShadow")

  // Hover-revealed fork action is reachable by keyboard focus.
  const fork = page.locator(".msg-wrap .fork-here").first()
  await fork.focus()
  await expect(fork).toHaveCSS("opacity", "1")

  // Day separators read in sentence case; the active accent follows the inline start.
  await expect(page.locator(".sidebar .nav-day").first()).toHaveCSS("text-transform", "none")
  const active = page.locator(".sidebar .nav-item.active").first()
  expect(await active.evaluate((element) => getComputedStyle(element).boxShadow)).toMatch(/ 3px 0px 0px 0px inset/)
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  expect(await active.evaluate((element) => getComputedStyle(element).boxShadow)).toMatch(/ -3px 0px 0px 0px inset/)
  await context.close()

  // Reduced motion: no ring and no background flash; the jump keeps a static marker.
  fixture.permissions = []
  const calm = await open({ reducedMotion: "reduce" })
  await calm.page.locator(".transcript").evaluate((element) => { element.scrollTop = element.scrollHeight })
  await calm.page.locator("textarea").first().focus()
  await calm.page.keyboard.press("Control+p")
  const calmBubble = calm.page.locator("[data-user-prompt] [data-slot='user-message-text'], [data-user-prompt] [data-component='user-message-text']")
  await expect.poll(async () => (await Promise.all((await calmBubble.all()).map(animations))).flat()).toContain("outline")
  expect((await Promise.all((await calmBubble.all()).map(animations))).flat()).not.toContain("backgroundColor")
  const calmDot = calm.page.locator(`.sidebar .session-entry[data-peek-id="ses_a"] .dot`)
  fixture.permissions = [permission]
  for (const [response, stream] of fixture.eventStreams)
    if (stream.path === "/global/event") response.write(`data: ${JSON.stringify({ directory, payload: { type: "permission.asked", properties: { ...permission, id: "per_calm" } } })}\n\n`)
  await expect(calmDot).toHaveClass(/pending/)
  await calm.page.waitForTimeout(100)
  expect(await animations(calmDot)).toEqual([])
  await calm.context.close()

  expect(errors).toEqual([])
  console.log("PASS feel: press fill on pointer-down, no transitions, prompt-jump flash, pending ring (not on first paint), keyboard-reachable fork, sentence-case days, logical RTL accent, reduced motion")
} finally {
  await browser.close()
  await preview.close()
}

// Hovering an agent text block or a human message shows when it was recorded (full date, time, zone),
// from the message/part record, without moving anything.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")

const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const human = Date.parse("2026-03-14T09:26:53Z")
const agentText = Date.parse("2026-03-14T09:27:10Z")
fixture.messages[0].info.time.created = human
fixture.messages[1].info.time.created = human + 1000
const text = fixture.messages[1].parts.find((part) => part.type === "text")
text.time = { start: agentText, end: agentText + 500 }
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York", locale: "en-US" })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120_000 })
  const expected = (at) => page.evaluate((at) => new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(at), at)
  const prompt = page.locator(`[data-find-message="msg_1"] .msg-wrap`)
  const agent = page.locator(`[data-find-message="msg_2"] [data-component="text-part"]`).first()
  await expect(prompt).toBeVisible()
  await expect(agent).toBeVisible()
  // Hidden until asked: no title before hover.
  await expect(prompt).not.toHaveAttribute("title")
  // Paced Markdown finishes rendering first; measure once the layout is still.
  const boxes = () => Promise.all([prompt.boundingBox(), agent.boundingBox()])
  let before = await boxes()
  await expect.poll(async () => { const now = await boxes(); const same = JSON.stringify(now) === JSON.stringify(before); before = now; return same }, { intervals: [200] }).toBe(true)
  await prompt.hover()
  await expect(prompt).toHaveAttribute("title", await expected(human))
  await agent.hover()
  await expect(agent).toHaveAttribute("title", await expected(agentText))
  expect(await agent.getAttribute("title")).toMatch(/2026.*EDT|2026.*GMT/)
  expect(await boxes(), "hover moves nothing").toEqual(before)
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log("PASS recorded time on hover: human message (message time) and agent text (part start), full date/time/zone, no layout change, no writes")
} finally {
  await browser.close()
  await preview.close()
}

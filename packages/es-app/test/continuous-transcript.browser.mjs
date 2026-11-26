// One continuous transcript across verified handoffs (DD #857/#858): scrolling up past a session's first message loads
// its predecessor above, read-only, with the reading position kept; the chain stops with a note when lineage is
// ambiguous. Fixture lane `work`: ses_a -> ses_b -> ses_c.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
fixture.sessionIDs.push("ses_c")
const turns = (session, word, count, start) => Array.from({ length: count }, (_, turn) => {
  const user = `msg_${session}_${String(turn * 2).padStart(4, "0")}`
  const assistant = `msg_${session}_${String(turn * 2 + 1).padStart(4, "0")}`
  const at = start + turn * 1000
  return [
    { info: { id: user, sessionID: session, role: "user", time: { created: at }, agent: "build", model: { providerID: "fixture", modelID: "test" } },
      parts: [{ id: `prt_${user}`, messageID: user, sessionID: session, type: "text", text: `${word} request ${turn}` }] },
    { info: { id: assistant, sessionID: session, role: "assistant", parentID: user, time: { created: at + 1, completed: at + 2 }, agent: "build",
        mode: "build", providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" },
      parts: [{ id: `prt_${assistant}`, messageID: assistant, sessionID: session, type: "text", text: `${word} answer ${turn}` }] },
  ]
}).flat()
fixture.messagesBySession = { ses_a: turns("ses_a", "alpha", 3, 1_000), ses_b: turns("ses_b", "bravo", 4, 100_000), ses_c: turns("ses_c", "charlie", 12, 200_000) }
fixture.handoffs = [
  { lane: "work", predecessor: "ses_a", successor: "ses_b", reason: "context full" },
  { lane: "work", predecessor: "ses_b", successor: "ses_c", reason: "rollover" },
]
fixture.laneOwners = [{ lane: "work", owner: "ses_c" }]
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1200, height: 700 } })
const page = await context.newPage()
page.setDefaultTimeout(20_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const href = (id) => `${preview.origin}/session/${id}?directory=${encodeURIComponent(directory)}`
const transcript = page.locator(".transcript").first()
const mutations = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))
// Scroll to the very top with a wheel-up, the same gesture a reader uses. The page pins itself to the bottom once its
// first load lands, so wait until the view really sits at the top before the wheel.
const scrollTop = async () => {
  await transcript.hover()
  await expect.poll(async () => {
    await transcript.evaluate((element) => { element.scrollTop = 0 })
    await page.waitForTimeout(100)
    return transcript.evaluate((element) => element.scrollTop)
  }).toBe(0)
  await page.mouse.wheel(0, -400)
}
const top = (locator) => locator.evaluate((element) => element.getBoundingClientRect().top)
try {
  await page.goto(href("ses_c"))
  await expect(page.getByText("charlie request 0", { exact: true })).toBeVisible()
  const previous = page.getByRole("separator", { name: "Previous session" })
  await expect(previous).toContainText("continued in a new session")
  await expect(previous.getByRole("link")).toHaveAttribute("href", `/session/ses_b?directory=${encodeURIComponent(directory)}`)
  await expect(previous).toContainText("rollover")
  await expect(page.locator("[data-earlier-session]")).toHaveCount(0)
  const before = mutations().length

  // Hop 1: ses_b loads above ses_c; ses_c's first row stays where it was.
  const first = page.getByText("charlie request 0", { exact: true })
  await scrollTop()
  const anchor = await top(first)
  await expect(page.locator('[data-earlier-session="ses_b"]')).toContainText("bravo answer 3", { timeout: 15_000 })
  await page.waitForTimeout(150)
  expect(Math.abs((await top(first)) - anchor)).toBeLessThanOrEqual(1)

  // Hop 2: ses_a, then the chain ends: no further loader, no note.
  await scrollTop()
  await expect(page.locator('[data-earlier-session="ses_a"]')).toContainText("alpha request 0", { timeout: 15_000 })
  await expect(page.getByRole("separator", { name: "Handoff" })).toContainText("context full")
  await scrollTop()
  await expect(page.getByRole("button", { name: "Load earlier session" })).toHaveCount(0)
  await expect(page.getByText("Earlier history isn't linked")).toHaveCount(0)
  // Order on the page: alpha, bravo, charlie.
  const order = await page.locator("[data-find-message]").evaluateAll((rows) => rows.map((row) => row.textContent?.match(/(alpha|bravo|charlie) request 0/)?.[1]).filter(Boolean))
  expect(order).toEqual(["alpha", "bravo", "charlie"])

  // Read-only: one composer, no fork or other row actions inside earlier sessions, nothing written.
  await expect(page.locator(".earlier-session .fork-here")).toHaveCount(0)
  await expect(page.locator(".earlier-session .prompt-box")).toHaveCount(0)
  expect(mutations().length).toBe(before)

  // Keyboard: the handoff links are reachable and open the earlier session as its own page.
  await previous.getByRole("link").focus()
  await expect(previous.getByRole("link")).toBeFocused()

  // Ambiguous lineage: a second edge into ses_b ends the chain after ses_b with a note.
  fixture.handoffs.push({ lane: "work", predecessor: "ses_z", successor: "ses_b" })
  await page.goto(href("ses_c"))
  await expect(page.getByText("charlie request 0", { exact: true })).toBeVisible()
  await scrollTop()
  await expect(page.locator('[data-earlier-session="ses_b"]')).toContainText("bravo", { timeout: 15_000 })
  await scrollTop()
  await expect(page.getByText("Earlier history isn't linked")).toBeVisible()
  await expect(page.locator('[data-earlier-session="ses_a"]')).toHaveCount(0)
  await page.screenshot({ path: process.env.SHOT ?? "/tmp/continuous-transcript.png" })
  expect(errors).toEqual([])
  console.log("PASS continuous transcript: 3-session chain loads upward with a fixed anchor, seams, read-only segments, keyboard link, ambiguous chain note")
} finally {
  await browser.close()
  await preview.close()
}

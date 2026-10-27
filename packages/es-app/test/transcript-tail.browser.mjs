import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { createFixture, directory } from "./composer-fixture.mjs"
import { warmVite } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const fixture = await createFixture()
fixture.status = "idle"
fixture.permissions = []
fixture.messages = Array.from({ length: 150 }, (_, turn) => {
  const user = `msg_${String(turn * 2).padStart(6, "0")}`
  const assistant = `msg_${String(turn * 2 + 1).padStart(6, "0")}`
  return [
    {
      info: { id: user, sessionID: "ses_a", role: "user", time: { created: turn * 1000 }, agent: "build", model: { providerID: "fixture", modelID: "test" } },
      parts: [{ id: `prt_${user}`, messageID: user, sessionID: "ses_a", type: "text", text: `Request ${turn}` }],
    },
    {
      info: {
        id: assistant, sessionID: "ses_a", role: "assistant", parentID: user,
        time: { created: turn * 1000 + 1, completed: turn * 1000 + 2 }, agent: "build", mode: "build",
        providerID: "fixture", modelID: "test", path: { cwd: directory, root: directory }, cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
      },
      parts: [{ id: `prt_${assistant}`, messageID: assistant, sessionID: "ses_a", type: "text", text: `Response ${turn}` }],
    },
  ]
}).flat()

process.env.OPENCODE_URL = fixture.url
process.env.ES_DASHBOARD_URL = fixture.url
const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
})
await vite.listen()
await warmVite(`http://127.0.0.1:${vite.httpServer.address().port}`, fixture)
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, channel: "chrome" })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route("**/*", (route) => {
    const request = new URL(route.request().url())
    return request.origin === origin || ["data:", "blob:"].includes(request.protocol) ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${origin}/session/ses_b?directory=${encodeURIComponent(directory)}`)
  await expect(page.locator(".topbar")).toContainText("Other session")
  await expect.poll(() => [...fixture.eventStreams.values()].some((stream) => stream.path === "/event" && stream.directory === directory)).toBe(true)
  await page.locator('.sidebar a[href*="/session/ses_a"]').first().click()
  const users = page.locator('[data-component="user-message"]')
  const messages = page.locator('[data-timeline-part-id^="prt_msg_"]')
  const older = page.locator(".transcript-older")
  const calls = () => fixture.calls.filter((call) => call.path === "/session/ses_a/message")
  await expect(users).toHaveCount(40)
  await expect(older).toBeVisible()
  expect(calls()).toHaveLength(1)
  expect(calls()[0]).toMatchObject({ limit: "80", before: null })

  // Keep the first message currently visible fixed, even when the new page
  // grows above it. DOM click avoids Playwright scrolling the button into view.
  const anchor = await page.evaluate(() => {
    const viewport = document.querySelector(".transcript").getBoundingClientRect()
    const nodes = [...document.querySelectorAll('[data-component="user-message"]')]
    const node = nodes.find((item) => item.getBoundingClientRect().top >= viewport.top)
    return { index: nodes.indexOf(node), top: node.getBoundingClientRect().top }
  })
  await page.evaluate(() => document.querySelector(".transcript-older").click())
  await expect(users).toHaveCount(80)
  expect(calls()).toHaveLength(2)
  expect(calls()[1]).toMatchObject({ limit: "80", before: "msg_000220" })
  await expect.poll(() => users.nth(anchor.index + 40).evaluate((node, top) => Math.abs(node.getBoundingClientRect().top - top), anchor.top)).toBeLessThanOrEqual(2)
  const ids = await messages.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-timeline-part-id")))
  expect(ids).toEqual([...new Set(ids)].sort())
  expect(ids).toHaveLength(160)

  await page.locator(".transcript").hover()
  await page.mouse.wheel(0, -100000)
  await expect(users).toHaveCount(120)
  expect(calls()).toHaveLength(3)
  expect(calls()[2]).toMatchObject({ limit: "80", before: "msg_000140" })
  await page.evaluate(() => document.querySelector(".transcript-older").click())
  await expect(users).toHaveCount(150)
  await expect(older).toHaveCount(0)
  expect(calls()).toHaveLength(4)
  expect(calls()[3]).toMatchObject({ limit: "80", before: "msg_000060" })
  expect(await messages.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-timeline-part-id")))).toEqual(
    fixture.messages.map((message) => `prt_${message.info.id}`),
  )
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
  for (const banner of ["Session connection lost", "Unable to load session", "Unable to refresh activity"])
    await expect(page.getByRole("alert").filter({ hasText: banner })).toHaveCount(0)
  console.log("transcript-tail: 80 initial, 80 click, 80 scroll, 60 final; viewport preserved; no errors")
} finally {
  await browser.close()
  await vite.close()
  await fixture.close()
}

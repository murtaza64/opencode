import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const id = (index) => `msg_${String(index).padStart(3, "0")}`
// 400 messages: the initial tail holds 320..399; older pages hold 80 messages each.
fixture.messages = Array.from({ length: 400 }, (_, index) => {
  const base = { id: id(index), sessionID: "ses_a", agent: "build", time: { created: index * 1000 } }
  const info = index % 2 === 0
    ? { ...base, role: "user", model: { providerID: "fixture", modelID: "test" } }
    : { ...base, role: "assistant", parentID: id(index - 1), mode: "build", providerID: "fixture", modelID: "test",
        path: { cwd: directory, root: directory }, cost: 0, finish: "stop",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: index * 1000, completed: index * 1000 + 500 } }
  return { info, parts: [{ id: `prt_${id(index)}`, messageID: id(index), sessionID: "ses_a", type: "text",
    text: `Message ${index}. ${"Fixture transcript line for scrolling. ".repeat(12)}` }] }
})
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const href = (query) => `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}${query}`
const row = (page, index) => page.locator(`[data-find-message="${id(index)}"]`)
const older = () => fixture.calls.filter((call) => call.path === "/session/ses_a/message" && call.before).map((call) => call.before)
const errors = []
const open = async (options = {}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  if (options.rtl) await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.dir = "rtl"
    document.documentElement.lang = "ar"
  }))
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  return { context, page }
}
try {
  {
    // An anchor in old history loads only the pages down to it.
    const { context, page } = await open()
    fixture.calls.length = 0
    await page.goto(href(`&message=${id(100)}`))
    await expect(row(page, 100)).toHaveAttribute("data-anchored", "true")
    await expect(row(page, 100)).toBeInViewport()
    expect(older()).toEqual([id(320), id(240), id(160)])
    await expect(row(page, 79)).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeVisible()
    await expect(page.locator(".anchor-note")).toHaveCount(0)
    await expect(page.locator("[data-anchored]")).toHaveCount(0, { timeout: 6000 })
    await expect(row(page, 100)).toBeInViewport()

    // An agent-shared link to another es-app port navigates in place and highlights the range.
    await page.evaluate((target) => {
      const link = document.createElement("a")
      link.href = target
      link.textContent = "brief link"
      link.id = "brief-link"
      document.body.append(link)
    }, `http://127.0.0.1:3181/session/ses_a?directory=${encodeURIComponent(directory)}&message=${id(331)}&to=${id(334)}`)
    await page.locator("#brief-link").click()
    await expect(page).toHaveURL(href(`&message=${id(331)}&to=${id(334)}`))
    await expect(page.locator("[data-anchored]")).toHaveCount(4)
    await expect(row(page, 331)).toBeInViewport()
    await expect(row(page, 335)).not.toHaveAttribute("data-anchored", "true")
    await context.close()
  }
  {
    // An unknown message opens the session normally with a note and never pages history.
    const { context, page } = await open()
    fixture.calls.length = 0
    await page.goto(href("&message=msg_nope"))
    await expect(page.locator(".anchor-note")).toContainText("Linked message isn't in this session")
    await expect(row(page, 399)).toBeInViewport()
    await expect(page.locator(".anchor-note")).toHaveAttribute("role", "status")
    expect(older()).toEqual([])
    await page.getByRole("button", { name: "Dismiss linked message note" }).click()
    await expect(page.locator(".anchor-note")).toHaveCount(0)

    // A range with an unknown end shows its known start.
    await page.goto(href(`&message=${id(390)}&to=msg_nope`))
    await expect(page.locator(".anchor-note")).toContainText("End of the linked range")
    await expect(row(page, 390)).toHaveAttribute("data-anchored", "true")
    await expect(page.locator("[data-anchored]")).toHaveCount(1)
    await context.close()
  }
  {
    // RTL: the anchor lands in view and the marker sits on the inline-start (right) edge.
    const { context, page } = await open({ rtl: true })
    await page.goto(href(`&message=${id(200)}&to=${id(201)}`))
    await expect(row(page, 200)).toHaveAttribute("data-anchored", "true")
    await expect(row(page, 200)).toBeInViewport()
    const marker = await row(page, 200).evaluate((element) => {
      const style = getComputedStyle(element, "::before")
      return { dir: getComputedStyle(element).direction, right: style.right, left: style.left }
    })
    expect(marker.dir).toBe("rtl")
    expect(marker.right).toBe("-6px")
    await context.close()
  }
  expect(errors).toEqual([])
  console.log("PASS message anchors: old-history window, in-place range link, unknown message note, unknown range end, RTL")
} finally {
  await browser.close()
  await preview.close()
}

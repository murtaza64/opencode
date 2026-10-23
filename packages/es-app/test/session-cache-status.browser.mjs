// T1–T3 (runtime-options/REPLACEMENT.md): navigation under a held or offline
// backend. A recently viewed transcript renders from the cache at once; a cold
// open shows one fixed skeleton; backend trouble reaches one status slot after
// it persists, without inline alerts or layout movement.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.sessionIDs.push("ses_c")
const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

// Backend modes for HTTP reads through the app's proxies. Event streams are left
// to the fixture (`disconnect()`), as the app multiplexes them over a socket.
let mode = "pass"
const held = []
await page.route(/\/(oc|es\/api)\//, (route) => {
  const path = new URL(route.request().url()).pathname
  if (path === "/oc/event" || path.startsWith("/es/api/events")) return route.continue()
  if (mode === "offline") return route.abort("connectionrefused")
  if (mode === "hold") return void held.push(route)
  return route.continue()
})
const goOffline = async () => {
  mode = "offline"
  await Promise.all(held.splice(0).map((route) => route.abort("connectionrefused").catch(() => {})))
  fixture.disconnect()
}
const goOnline = async () => {
  mode = "pass"
  await Promise.all(held.splice(0).map((route) => route.continue().catch(() => {})))
}

const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const status = page.locator(".session-work-status:visible")
const transcript = page.locator(".session-page .transcript, .session-main .transcript").first()
const composer = page.locator(".direct-composer:visible")
const firstMessage = page.getByText("Review the composer and its session controls.")
const open = async (id) => {
  await page.locator(`.nav-item[href*="${id}"]`).first().click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${id}`)
}
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const box = async (locator) => {
  const value = await locator.boundingBox()
  return value && { x: value.x, y: value.y, width: value.width, height: value.height }
}
// Records every status state change until stopped.
const watchStatus = () => page.evaluate(() => {
  const states = []
  const read = () => document.querySelector(".session-work-status")?.getAttribute("data-state") ?? "none"
  states.push(read())
  const timer = setInterval(() => { if (read() !== states.at(-1)) states.push(read()) }, 50)
  window.__stopStatus = () => { clearInterval(timer); return states }
})
const stopStatus = () => page.evaluate(() => window.__stopStatus())

try {
  await page.goto(preview.url)
  await expect(firstMessage).toBeVisible()
  await open("ses_b")

  // T1: back to A while every read hangs: the cached transcript is already there.
  mode = "hold"
  await open("ses_a")
  await expect(firstMessage).toBeVisible({ timeout: 300 })
  await expect(page.locator(".transcript-skeleton")).toHaveCount(0)
  await settle()
  const cachedBox = await box(transcript)
  await watchStatus()
  await goOffline()
  await expect(status).toHaveAttribute("data-state", "disconnected", { timeout: 5000 })
  await expect(status).toContainText("showing saved transcript")
  await expect(firstMessage).toBeVisible()
  expect(await box(transcript)).toEqual(cachedBox)
  console.info("PASS T1 cached transcript renders while backend is held, and stays while offline")

  // T3: offline for a while: one status element, no inline alerts, no flapping.
  await page.waitForTimeout(6000)
  const states = await stopStatus()
  await expect(page.locator(".session-work-status")).toHaveCount(1)
  await expect(page.locator(".session-alerts [role=alert]")).toHaveCount(0)
  expect(states.at(-1)).toBe("disconnected")
  expect(states.length).toBeLessThanOrEqual(3)
  expect(await box(transcript)).toEqual(cachedBox)
  console.info(`PASS T3 offline: single status slot, 0 inline alerts, states ${states.join(" → ")}`)

  // T2: cold open of an unvisited session while reads hang, then fail, then recover.
  await goOnline()
  await expect(status).not.toHaveAttribute("data-state", "disconnected", { timeout: 20000 })
  mode = "hold"
  await open("ses_c")
  await expect(page.locator(".transcript-skeleton")).toBeVisible()
  await settle()
  const coldTranscript = await box(transcript)
  const coldComposer = await box(composer)
  await expect(status).toHaveAttribute("data-state", "stale", { timeout: 5000 })
  await expect(status).toContainText("Waiting for daemon")
  await goOffline()
  await expect(status).toHaveAttribute("data-state", "disconnected", { timeout: 5000 })
  await expect(page.locator(".transcript-skeleton")).toHaveCount(1)
  await expect(page.locator(".session-alerts [role=alert]")).toHaveCount(0)
  expect(await box(transcript)).toEqual(coldTranscript)
  expect(await box(composer)).toEqual(coldComposer)
  await goOnline()
  await expect(page.locator(".transcript-skeleton")).toHaveCount(0, { timeout: 20000 })
  await expect(status).not.toHaveAttribute("data-state", /disconnected|stale/, { timeout: 20000 })
  await settle()
  expect(await box(transcript)).toEqual(coldTranscript)
  expect(await box(composer)).toEqual(coldComposer)
  console.info("PASS T2 cold open: one skeleton, stable transcript/composer geometry through hold, offline and recovery")

  expect(errors).toEqual([])
} finally {
  await browser.close()
  await preview.close()
}

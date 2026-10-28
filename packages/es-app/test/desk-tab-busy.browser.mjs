// The Front desk nav entry shows a busy dot while the desk chat session works, from the shared session
// status stream only: busy -> dot, idle -> none, unknown session -> none, and no extra requests.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.status = "idle"
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const nav = page.locator('.nav-entry[data-nav="front-desk"]')
const dot = nav.locator(".nav-busy")
// The app reads cross-session status from the global stream ({directory, payload}).
const globalStatus = (sessionID, type, dir = directory) => {
  for (const [response, entry] of fixture.eventStreams)
    if (entry.path === "/global/event") response.write(`data: ${JSON.stringify({ directory: dir, payload: { type: "session.status", properties: { sessionID, status: { type } } } })}\n\n`)
}
try {
  await page.addInitScript(([dir]) => localStorage.getItem("es-app:front-desk:1") ?? localStorage.setItem("es-app:front-desk:1", JSON.stringify({ session: "ses_a", directory: dir })), [directory])
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 120000 })
  await expect(page.locator('.desk-companion [data-component="user-message"]').first()).toHaveCount(1, { timeout: 60000 })
  await expect(nav).toBeVisible()
  await expect(page.locator('.desk-companion.closed')).toHaveCount(1)
  await expect(dot).toHaveCount(0)

  const before = fixture.calls.length
  await page.waitForTimeout(1000)
  globalStatus("ses_a", "busy")
  await expect(dot).toHaveCount(1)
  await expect(dot).toHaveAttribute("aria-label", "Front desk is working")
  const tab = await nav.boundingBox()
  globalStatus("ses_a", "idle")
  await expect(dot).toHaveCount(0)
  expect(await nav.boundingBox(), "nav entry geometry unchanged").toEqual(tab)
  const extra = fixture.calls.slice(before).filter((call) => !/\/event|\/api\/(state|events)|\/session\/status/.test(call.path))
  expect(extra.map((call) => call.path), "status changes add no requests").toEqual([])

  // A desk session the status stream does not know is unknown, not idle and not busy.
  await page.evaluate(() => localStorage.setItem("es-app:front-desk:1", JSON.stringify({ session: "ses_unknown", directory: "/nowhere" })))
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await expect(nav).toBeVisible({ timeout: 60000 })
  await page.waitForTimeout(1000)
  globalStatus("ses_a", "busy")
  await page.waitForTimeout(500)
  await expect(dot).toHaveCount(0)
  expect(errors).toEqual([])
  console.log("PASS desk nav busy: busy dot from session status, idle clears, unknown hidden, stable entry, no extra requests")
} finally {
  await browser.close()
  await preview.close()
}

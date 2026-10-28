// Sidebar busy wave and row stability (NAV-09, dotfiles#240): busy halos are offset row by row (a wave, not one
// pulse); session updates that only bump time neither reorder nor remount rows, so a row keeps its DOM node and its
// halo phase; reduced motion is static. Disposable fixture; no writes. Run: node test/sidebar-wave.browser.mjs
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.workspaceSessions.push({ ...session("ses_c"), title: "Third session", time: { created: 1, updated: Date.now() } })
const browser = await chromium.launch({ channel: "chrome", headless: true })
const publish = (sessionID, type) => {
  for (const [response, stream] of preview.fixture.eventStreams) if (stream.path === "/global/event")
    response.write(`data: ${JSON.stringify({ directory, payload: { type: "session.status", properties: { sessionID, status: { type } } } })}\n\n`)
}
const bump = (id) => {
  const info = { ...preview.fixture.workspaceSessions.find(item => item.id === id) ?? session(id), time: { created: 1, updated: Date.now() } }
  for (const [response, stream] of preview.fixture.eventStreams) if (stream.path === "/global/event")
    response.write(`data: ${JSON.stringify({ directory, payload: { type: "session.updated", properties: { sessionID: id, info } } })}\n\n`)
}
const check = async (reducedMotion) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion })
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
  await context.addInitScript(() => { try { localStorage.removeItem("es-app-sidebar-pins") } catch {} })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  await page.goto(`${preview.url}`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const list = page.locator(".sidebar [role=tabpanel]")
  await expect(list.locator(".session-entry")).toHaveCount(3, { timeout: 120_000 })
  await expect.poll(() => [...preview.fixture.eventStreams.values()].some(s => s.path === "/global/event")).toBe(true)
  // Active above idle (NAV-11): only ses_c busy -> it leads; going idle moves it back, by title.
  publish("ses_c", "busy")
  await expect(list.locator(".session-entry .nav-title").first()).toHaveText("Third session")
  publish("ses_c", "idle")
  await expect(list.locator(".session-entry .dot.busy")).toHaveCount(0)
  const idleOrder = await list.locator(".session-entry .nav-title").allTextContents()
  assert.deepEqual(idleOrder, [...idleOrder].sort((a, b) => a.localeCompare(b)), `idle rows by title: ${idleOrder}`)
  for (const id of ["ses_a", "ses_b", "ses_c"]) publish(id, "busy")
  await expect(list.locator(".dot.busy")).toHaveCount(3)
  const halos = () => list.locator(".session-entry").evaluateAll(rows => rows.map(row => {
    const style = getComputedStyle(row.querySelector(".dot"), "::after")
    return { name: style.animationName, delay: style.animationDelay }
  }))
  const before = await halos()
  const order = await list.locator(".session-entry .nav-title").allTextContents()
  await list.locator(".session-entry").first().evaluate(el => { el.dataset.probe = "kept" })
  // Streamed session updates that only bump time: same order, same DOM nodes.
  for (const id of ["ses_c", "ses_a", "ses_b"]) bump(id)
  await page.waitForTimeout(800)
  assert.deepEqual(await list.locator(".session-entry .nav-title").allTextContents(), order, "no reorder on time bumps")
  await expect(list.locator('.session-entry[data-probe="kept"]')).toHaveCount(1)
  await context.close()
  return before
}
try {
  const moving = await check("no-preference")
  assert(moving.every(h => h.name === "busy-halo"), `busy rows animate: ${JSON.stringify(moving)}`)
  assert.equal(new Set(moving.map(h => h.delay)).size, moving.length, `each row has its own phase: ${JSON.stringify(moving)}`)
  const still = await check("reduce")
  assert(still.every(h => h.name === "none"), `reduced motion is static: ${JSON.stringify(still)}`)
  console.log("PASS sidebar wave: active rows above idle (NAV-11), busy halos offset per row, no reorder or remount on time bumps, reduced motion static")
} finally {
  await browser.close()
  await preview.close()
}

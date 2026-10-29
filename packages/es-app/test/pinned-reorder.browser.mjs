// NAV18 Pinned reorder: one interleaved Pinned list across Local and the Mac Mini. Dragging a Local row by its grip
// and Alt+ArrowUp on a Mini row write that row's own host order (PATCH .../order) and the list follows; a move the
// owning host cannot take now (its pins not synced) is refused with a note and nothing changes. Also RTL/390px.
// Disposable fixture. Run from packages/es-app: node test/pinned-reorder.browser.mjs
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const miniDir = "/Users/mini/fixture"
let miniPinsDown = false
const now = Date.now()
const stores = {
  local: { rev: 1, pins: [{ ref: "session:ses_a", pinnedAt: now - 3000, order: 1, orderAt: now - 3000 }, { ref: "session:ses_b", pinnedAt: now - 1000, order: 3, orderAt: now - 1000 }] },
  mini: { rev: 1, pins: [{ ref: "session:ses_m1", pinnedAt: now - 2000, order: 2, orderAt: now - 2000 }] },
}
const writes = []
const servePins = (host) => async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  if (host === "mini" && miniPinsDown) return route.fulfill({ status: 503, json: { error: "pins unavailable" } })
  const store = stores[host]
  if (request.method() === "GET") return route.fulfill({ json: { rev: store.rev, pins: store.pins, tombstones: [] } })
  const ref = decodeURIComponent(url.pathname.replace(/^.*\/es\/api\/pins\//, "").replace(/\/order$/, ""))
  const body = request.postDataJSON()
  // Reorders only (a first-run migration may PUT existing pins; those are not moves).
  if (request.method() === "PATCH") writes.push({ host, method: request.method(), ref, order: body.order })
  const pin = store.pins.find((item) => item.ref === ref)
  if (pin && request.method() === "PATCH") Object.assign(pin, { order: body.order, orderAt: body.at })
  store.rev++
  return route.fulfill({ json: { rev: store.rev, applied: true, current: pin ? { state: "pinned", pinnedAt: pin.pinnedAt, order: pin.order, orderAt: pin.orderAt } : null } })
}
// Shared pins need a named, syncable host and one profile across the Work hosts.
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "laptop", label: "Laptop", remote: false, profile: "work", hosts: [], work: [
  { id: "laptop", label: "Laptop", origin: preview.fixture.url, profile: "work" },
  { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:65041", profile: "work" },
] } }))
await page.route((url) => /^\/es\/api\/pins/.test(new URL(url).pathname), servePins("local"))
await page.route("**/es/api/attention/session", (route) => route.fulfill({ json: { operator: true, answer: true } }))
await page.route("**/hosts/mini/**", (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\/hosts\/mini/, "")
  if (path.startsWith("/es/api/pins")) return servePins("mini")(route)
  if (path === "/oc/experimental/session") return route.fulfill({ json: [{ id: "ses_m1", title: "Mini pinned", directory: miniDir, time: { created: 1, updated: now } }] })
  if (path === "/es/api/attention/session") return route.fulfill({ json: { operator: true, answer: true } })
  if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniDir}/.editspace` }], default: "fixture" } })
  if (path === "/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false } })
  return route.fulfill({ json: [] })
})
const pinned = page.locator("nav.sidebar .pinned-section")
const titles = () => pinned.locator(".pin-slot .nav-title").allTextContents()
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect.poll(titles, { timeout: 120_000 }).toEqual(["Composer fixture", "Mini pinned", "Other session"])

  // Drag "Other session" (Local) by its grip above "Composer fixture": Local's own order is written.
  const grip = pinned.locator(".pin-slot", { hasText: "Other session" }).locator(".pin-grip")
  const first = pinned.locator(".pin-slot").first()
  await pinned.locator(".pin-slot", { hasText: "Other session" }).hover()
  const from = await grip.boundingBox()
  const to = await first.boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 2, to.y + 4, { steps: 8 })
  await expect(pinned.locator(".pin-slot.drop-before")).toHaveCount(1)
  await page.mouse.up()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ host: "local", method: "PATCH", ref: "session:ses_b" })
  expect(writes[0].order).toBeLessThan(1)
  await expect.poll(titles).toEqual(["Other session", "Composer fixture", "Mini pinned"])

  // Keyboard: Alt+ArrowUp on the Mini row writes the Mini's order, between its new neighbours; focus stays on it.
  const miniLink = pinned.locator(".pin-slot", { hasText: "Mini pinned" }).locator("a.nav-item")
  await miniLink.focus()
  await page.keyboard.press("Alt+ArrowUp")
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toMatchObject({ host: "mini", method: "PATCH", ref: "session:ses_m1" })
  expect(writes[1].order).toBeGreaterThan(writes[0].order)
  expect(writes[1].order).toBeLessThan(1)
  await expect.poll(titles).toEqual(["Other session", "Mini pinned", "Composer fixture"])
  await expect(miniLink).toBeFocused()

  // RTL, narrow: still one column, nothing overflows.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  if (overflow > 1) throw new Error(`RTL 390px overflows by ${overflow}px`)
  await page.screenshot({ path: "/tmp/pinned-reorder-rtl-390.png" })
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.setViewportSize({ width: 1280, height: 900 })

  // The Mini's pins stop syncing: moving its row is refused with a note; nothing is written or reordered.
  miniPinsDown = true
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(pinned.locator(".pin-sync")).toHaveText("not synced", { timeout: 120_000 })
  const before = await titles()
  const writesBefore = writes.length
  const stuck = pinned.locator(".pin-slot", { hasText: "Mini pinned" }).locator("a.nav-item")
  // Unsynced, its row follows the synced ones (last-known), so the move up is the one refused.
  await expect(stuck).toHaveCount(1)
  await stuck.focus()
  await page.keyboard.press("Alt+ArrowUp")
  await expect(pinned.locator(".pin-note")).toContainText("Nothing changed")
  expect(writes.length).toBe(writesBefore)
  expect(await titles()).toEqual(before)
  expect(errors).toEqual([])
  console.log("pinned-reorder: PASS")
} finally {
  await browser.close()
  await preview.close()
}

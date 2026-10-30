// NAV-03: the Surfaces tab is one list of this host's and the Mac Mini's Surfaces, newest published first
// (updated_at), interleaved by host; a Surface without a date goes last under "Date unknown"; equal dates by title.
// Type chips from the author's form/accents narrow it together with the text filter. Run from packages/es-app.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const now = Date.now()
const surface = (id, title, updated, extra = {}) => ({ id, title, summary: null, kind: "path", owner: "fixture", lane: null, editspace: "fixture", updated_at: updated, revision: 1, health: { state: "ok" }, ...extra })
const miniDir = "/Users/mini/fixture"
await page.addInitScript(() => localStorage.setItem("es-app:nav-tab", "surfaces"))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url }, { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:65051" }] } }))
await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [
  surface("ops", "Ops report", now - 60_000, { form: "document", accents: ["interactive"] }),
  surface("old", "Old notes", now - 86_400_000, { form: "document" }),
  surface("nodate", "Undated page", 0),
  surface("tie_b", "Beta tie", now - 30_000),
] } }))
await page.route("**/hosts/mini/**", (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\/hosts\/mini/, "")
  if (path === "/oc/experimental/session") return route.fulfill({ json: [{ id: "ses_m", title: "Mini worker", directory: miniDir, time: { created: 1, updated: now } }] })
  if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniDir}/.editspace` }], default: "fixture" } })
  if (path === "/es/api/surfaces") return route.fulfill({ json: { surfaces: [
    surface("relay", "Relay board", now - 10_000, { form: "dashboard", accents: ["live"] }),
    surface("tie_a", "Alpha tie", now - 30_000),
  ] } })
  if (path === "/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false } })
  return route.fulfill({ json: [] })
})
const panel = page.locator("nav.sidebar [role=tabpanel]")
const titles = () => panel.locator(".nav-surface .nav-title").allTextContents()
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  // Newest first across hosts (the Mini's Relay board leads); equal times by title; undated last.
  await expect.poll(titles, { timeout: 120_000 }).toEqual(["Relay board", "Alpha tie", "Beta tie", "Ops report", "Old notes", "Undated page"])
  await expect(panel.locator(".nav-surface", { hasText: "Relay board" })).toHaveClass(/host-surface/)
  await expect(panel.locator(".nav-day")).toHaveText("Date unknown")
  // Type chips for the types present; one narrows the list, again clears it; the text filter still applies.
  const chips = panel.getByRole("group", { name: "Surface type" })
  await expect(chips.getByRole("button")).toHaveText(["Document", "Dashboard", "Interactive", "Live"])
  await chips.getByRole("button", { name: "Document" }).click()
  await expect.poll(titles).toEqual(["Ops report", "Old notes"])
  await panel.getByRole("searchbox", { name: "Filter Surfaces" }).fill("ops")
  await expect.poll(titles).toEqual(["Ops report"])
  await panel.getByRole("searchbox", { name: "Filter Surfaces" }).fill("")
  await chips.getByRole("button", { name: "Document" }).click()
  await chips.getByRole("button", { name: "Live" }).click()
  await expect.poll(titles).toEqual(["Relay board"])
  await chips.getByRole("button", { name: "Live" }).click()
  await expect.poll(titles).toHaveLength(6)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await panel.screenshot({ path: "/tmp/surfaces-order-rtl.png" })
  expect(errors).toEqual([])
  console.log("surfaces-order: PASS")
} finally {
  await browser.close()
  await preview.close()
}

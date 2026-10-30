// Surface icons at actual size (Desk #151): tagged and untagged Surfaces from this host and the Mac Mini in one list.
// Untagged rows make no type claim but must not read as a missing image; Work-host rows keep the host in text and in
// the accessible name without a second glyph beside the type icon. Crops at 14/16/20px and RTL. Run from packages/es-app.
import { createRequire } from "node:module"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: "chrome" }) })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
const now = Date.now()
const label = process.env.LABEL ?? "after"
const surface = (id, title, updated, extra = {}) => ({ id, title, summary: null, kind: "path", owner: "fixture", lane: null, editspace: "fixture", updated_at: updated, revision: 1, health: { state: "ok" }, form: null, accents: [], ...extra })
const miniDir = "/Users/mini/fixture"
await page.addInitScript(() => localStorage.setItem("es-app:nav-tab", "surfaces"))
await page.route("**/__es/host", (route) => route.fulfill({ json: { id: "local", label: "Local", remote: false, hosts: [], work: [
  { id: "local", label: "Local", origin: preview.fixture.url }, { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:65061" }] } }))
await page.route((url) => new URL(url).pathname === "/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [
  surface("ops", "Ops report", now - 20_000, { form: "document", accents: ["interactive"] }),
  surface("plain", "Laptop notes", now - 40_000),
] } }))
await page.route("**/hosts/mini/**", (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\/hosts\/mini/, "")
  if (path === "/oc/experimental/session") return route.fulfill({ json: [] })
  if (path === "/es/api/editspaces") return route.fulfill({ json: { editspaces: [{ name: "fixture", root: `${miniDir}/.editspace` }], default: "fixture" } })
  if (path === "/es/api/surfaces") return route.fulfill({ json: { surfaces: [
    surface("relay", "Relay board", now - 10_000, { form: "dashboard", accents: ["live"] }),
    surface("brief", "Brief gallery", now - 30_000),
    surface("cost", "Cost sheet", now - 50_000),
  ] } })
  if (path === "/es/api/attention") return route.fulfill({ json: { records: [], projects: [], partial: false } })
  return route.fulfill({ json: [] })
})
const panel = page.locator("nav.sidebar [role=tabpanel]")
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(panel.locator(".nav-surface")).toHaveCount(5, { timeout: 120_000 })
  if (label === "after") {
    // Untagged: a neutral surface glyph, not an empty square; it claims no form.
    const plain = panel.locator(".nav-surface", { hasText: "Laptop notes" })
    await expect(plain.locator("svg.surface-glyph[data-form]")).toHaveCount(0)
    await expect(plain.locator("svg.surface-glyph-generic")).toHaveCount(1)
    await expect(page.getByRole("link", { name: /^Laptop notes\s*, surface/ })).toBeVisible()
    // Work-host rows: one glyph (the type), the host as trailing text and in the name.
    const mini = panel.locator(".nav-surface", { hasText: "Brief gallery" })
    await expect(mini.locator(".host-glyph")).toHaveCount(0)
    await expect(mini.locator(".session-project")).toHaveText("Mac Mini")
    await expect(page.getByRole("link", { name: /^Brief gallery, surface, on Mac Mini/ })).toBeVisible()
  }
  for (const size of [14, 16, 20]) {
    await page.evaluate((value) => document.documentElement.style.setProperty("--surface-glyph-size", `${value}px`), size)
    await panel.screenshot({ path: `/tmp/surface-icons-${label}-${size}.png` })
  }
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await page.evaluate(() => document.documentElement.style.setProperty("--surface-glyph-size", "14px"))
  await panel.screenshot({ path: `/tmp/surface-icons-${label}-rtl.png` })
  expect(errors).toEqual([])
  console.log(`surface-icons-mixed (${label}): PASS`)
} finally {
  await browser.close()
  await preview.close()
}

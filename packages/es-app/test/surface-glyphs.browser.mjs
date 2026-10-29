// NAV-19 Surface glyphs: each Surface row shows the author's form with static accents, untagged rows keep the plain
// square, and the row's accessible name says the kind. Shots at 14/16/20px and RTL for review.
// Run from packages/es-app: node test/surface-glyphs.browser.mjs
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
const surface = (id, title, extra) => ({ id, title, summary: null, kind: "path", owner: "fixture", lane: null, editspace: "fixture", updated_at: now, revision: 1, health: { state: "ok" }, ...extra })
await page.addInitScript(() => localStorage.setItem("es-app:nav-tab", "surfaces"))
await page.route("**/es/api/surfaces", (route) => route.fulfill({ json: { surfaces: [
  surface("ops", "Ops report", { form: "document", accents: ["interactive"] }),
  surface("relay", "Relay board", { form: "dashboard", accents: ["live"] }),
  surface("wal", "WalStudio", { form: "prototype", accents: ["interactive", "live"] }),
  surface("spec", "Plain spec", { form: "document" }),
  surface("old", "Untagged page", { kind: "url" }),
  surface("odd", "Unknown tags", { form: "report", accents: ["sparkly"] }),
] } }))
const row = (id) => page.locator(`nav.sidebar [data-nav-item='surface:${id}']`)
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded", timeout: 300_000 })
  await expect(row("ops")).toBeVisible({ timeout: 120_000 })
  await expect(row("ops").locator("svg.surface-glyph")).toHaveAttribute("data-form", "document")
  await expect(row("ops").locator("svg.surface-glyph")).toHaveAttribute("data-accents", "interactive")
  await expect(row("relay").locator("svg.surface-glyph")).toHaveAttribute("data-accents", "live")
  await expect(row("wal").locator("svg.surface-glyph")).toHaveAttribute("data-accents", "interactive live")
  await expect(row("wal").locator(".surface-glyph-accent")).toHaveCount(2)
  await expect(row("spec").locator(".surface-glyph-accent")).toHaveCount(0)
  for (const id of ["old", "odd"]) {
    await expect(row(id).locator("svg.surface-glyph")).toHaveCount(0)
    await expect(row(id).locator(".nav-kind")).toHaveText("▢")
  }
  await expect(page.getByRole("link", { name: /^Ops report\s*, document, interactive/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /^Untagged page\s*, surface/ })).toBeVisible()
  // Accents never use the status dot.
  await expect(page.locator("nav.sidebar .nav-surface .dot")).toHaveCount(0)
  const list = page.locator("nav.sidebar [role=tabpanel]")
  for (const size of [14, 16, 20]) {
    await page.evaluate((value) => document.documentElement.style.setProperty("--surface-glyph-size", `${value}px`), size)
    await list.screenshot({ path: `/tmp/surface-glyphs-${size}.png` })
  }
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await list.screenshot({ path: "/tmp/surface-glyphs-rtl.png" })
  expect(errors).toEqual([])
  console.log("surface-glyphs: PASS")
} finally {
  await browser.close()
  await preview.close()
}

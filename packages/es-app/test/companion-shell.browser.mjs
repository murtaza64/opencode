// Front desk companion shell (#265): the conversation keeps the space. The header title is plain text even when it
// contains the session's own ID (no self-referencing chip); the composer starts small (about two lines) and grows with
// what is typed; an idle status line is not shown; each reply carries one meta line. Disposable fixture.
// Run from packages/es-app: node test/companion-shell.browser.mjs [--shots DIR]
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : undefined
const preview = await startPanelPreview()
preview.fixture.status = "idle"
const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await context.addInitScript(value => { try { localStorage.setItem("es-app:front-desk:1", JSON.stringify(value)); localStorage.setItem("es-app:companion:work", "1") } catch {} }, { session: "ses_b", directory })
// The desk session's title quotes its own ID, as Front Desk titles do.
await context.route("**/oc/session/ses_b?*", async route => {
  const response = await route.fetch()
  const body = await response.json().catch(() => undefined)
  if (!body || typeof body !== "object") return route.fulfill({ response })
  return route.fulfill({ response, json: { ...body, title: "Front desk @ses_bbbbbbbbbbbbbbbbbbbbbbbbbb" } })
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const errors = []
page.on("pageerror", error => errors.push(error.message))
try {
  await page.goto(`${preview.origin}/agents`, { waitUntil: "domcontentloaded", timeout: 300_000 })
  const companion = page.locator(".desk-companion")
  const editor = companion.locator(".direct-composer textarea")
  await expect(editor).toBeVisible({ timeout: 120_000 })
  // No chip inside the header title.
  await expect(companion.locator(".session-title .session-ref, .session-title .session-chip")).toHaveCount(0)
  // Small composer that grows.
  const small = await editor.evaluate(el => el.getBoundingClientRect().height)
  assert(small <= 64, `composer starts about two lines high (${small}px)`)
  await editor.fill(Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n"))
  const grown = await editor.evaluate(el => el.getBoundingClientRect().height)
  assert(grown > small + 40, `composer grows with its text (${small} -> ${grown})`)
  await editor.fill("")
  // Idle: no status line.
  await expect(companion.locator(".session-work-status[data-state=idle]")).toBeHidden()
  // One meta line per reply.
  await expect(companion.locator("[data-slot=text-part-meta]:visible")).toHaveCount(0)
  if (shots) await page.screenshot({ path: path.join(shots, "companion-shell.png") })
  assert.deepEqual(errors, [])
  console.log("PASS companion shell: header title without self chip, two-line growing composer, no idle status line, single reply meta")
} finally {
  await browser.close()
  await preview.close()
}

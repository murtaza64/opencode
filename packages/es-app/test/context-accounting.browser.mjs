// #157: the exact latest-turn provider accounting rows collapse by default in
// the right panel behind a one-line gist; the exact context percentage and the
// estimated visible-content bar stay visible; the toggle is remembered per client.
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.messages[1].info.time.completed = 3
fixture.messages[1].info.tokens = { input: 3, output: 608, reasoning: 46, cache: { read: 471919, write: 491 } }
fixture.messagesB = [
  { info: { id: "b_1", sessionID: "ses_b", role: "user", agent: "build", model: { providerID: "fixture", modelID: "test" }, time: { created: 1 } },
    parts: [{ id: "bp_1", messageID: "b_1", sessionID: "ses_b", type: "text", text: "hello" }] },
  { info: { id: "b_2", sessionID: "ses_b", role: "assistant", agent: "build", providerID: "fixture", modelID: "test", parentID: "b_1",
    path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 2, completed: 3 } },
    parts: [{ id: "bp_2", messageID: "b_2", sessionID: "ses_b", type: "text", text: "hi" }] },
]
const providers = { providers: [{ id: "fixture", models: { test: { id: "test", limit: { context: 500000 } } } }], default: {} }
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "context-accounting-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" } }) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 900 } })
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await page.context().route("**/*", (route) => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
await page.route("**/config/providers*", (route) => route.fulfill({ json: providers }))
const panel = page.locator(".session-info")
const disclosure = panel.locator(".ctx-accounting-disclosure")
const summary = disclosure.locator("> summary")
const rows = panel.locator(".ctx-provider li")
const shot = async (name) => { if (process.env.CONTEXT_ACCOUNTING_SHOTS) await page.screenshot({ path: `${process.env.CONTEXT_ACCOUNTING_SHOTS}-${name}.png` }) }
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  // exact percent, bar and legend remain visible while the rows are collapsed
  await expect(panel.locator(".ctx-exact")).toContainText("473k / 500k (95%)")
  await expect(panel.locator(".ctx-exact.high")).toHaveCount(1)
  await expect(panel.locator(".ctx-bar")).toBeVisible()
  await expect(panel.locator(".ctx-legend li", { hasText: "assistant text" })).toBeVisible()
  await expect(disclosure).not.toHaveAttribute("open")
  await expect(summary).toHaveAttribute("aria-label", "exact latest-turn provider accounting")
  await expect(summary.locator(".ctx-gist")).toHaveText("cache read 100% · output 608")
  await expect(panel.locator(".ctx-provider")).not.toBeVisible()
  expect(await panel.evaluate((el) => el.innerText.includes("471,919"))).toBe(false)
  const collapsedHeight = await panel.locator("[data-section='context']").evaluate((el) => el.getBoundingClientRect().height)
  await shot("collapsed")

  // keyboard expand reveals every exact class with numeric and percentage detail
  await summary.focus()
  await page.keyboard.press("Enter")
  await expect(disclosure).toHaveAttribute("open", "")
  await expect(rows).toHaveCount(5)
  await expect(rows.filter({ hasText: "cache read" })).toContainText("471,919")
  await expect(rows.filter({ hasText: "cache read" })).toContainText("100%")
  await expect(rows.filter({ hasText: "cache write" })).toContainText("491")
  await expect(rows.filter({ hasText: "uncached input" })).toContainText("3")
  await expect(rows.filter({ hasText: "generated output" })).toContainText("608")
  await expect(rows.filter({ hasText: "reasoning" })).toContainText("46")
  await expect(rows.filter({ hasText: "cache read" }).locator(".mono").first()).toHaveAttribute("title", "471,919 tokens")
  await expect(panel.locator(".ctx-accounting .ctx-caption")).toContainText("provider accounting classes, not content sources")
  expect(await panel.locator("[data-section='context']").evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight + 40)
  await shot("expanded")

  // the open state persists per client across reload and across sessions
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(disclosure).toHaveAttribute("open", "")
  await expect(rows.filter({ hasText: "cache read" })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("es-app-ctx-accounting-open"))).toBe("1")
  await summary.click()
  await expect(disclosure).not.toHaveAttribute("open")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(disclosure).not.toHaveAttribute("open")
  await expect(summary.locator(".ctx-gist")).toHaveText("cache read 100% · output 608")

  // unknown usage: gist says so, no fabricated rows
  await page.goto(`${preview.origin}/session/ses_b?directory=${encodeURIComponent(directory)}`, { waitUntil: "domcontentloaded" })
  await expect(panel.locator(".ctx-exact")).toContainText("latest turn context unknown")
  await expect(summary.locator(".ctx-gist")).toHaveText("unknown")
  await summary.click()
  await expect(panel.locator(".ctx-accounting .ctx-caption")).toHaveText("provider usage unknown")
  await expect(rows).toHaveCount(0)
  await summary.click()
  await expect(disclosure).not.toHaveAttribute("open")

  // mobile + RTL: gist stays on one line without horizontal overflow
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(summary.locator(".ctx-gist")).toBeVisible()
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await shot("mobile-rtl")

  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS context accounting ${app ? "native" : "browser"}: collapsed by default with gist, exact percent/bar/legend visible, keyboard expand with exact rows, persisted toggle, unknown handling, mobile RTL, zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

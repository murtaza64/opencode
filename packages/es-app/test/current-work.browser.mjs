import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const turn = { started_at: Date.now() - 80_000, elapsed_seconds: 80, status: "busy", user_messages: 1,
  assistant_messages: 2, tool_calls: 3, active_tools: [{ name: "bash", status: "running" }], watermark: "a" }
fixture.currentWork = (id, dir) => {
  expect(dir).toBe(directory)
  return { turn: { ...turn }, summary: { status: "ready", text: `Reviewing ${id}`, generated_at: Math.floor(Date.now() / 1000) - 30, watermark: "a" } }
}
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "current-work-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 900 } })
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const calls = (id) => fixture.calls.filter((call) => call.path === "/api/current-work" && (!id || call.sessionID === id))
const panel = page.locator(".session-info [data-section='current-work']")
const card = page.locator(".session-peek")
const rowA = page.locator(".session-entry[data-peek-id='ses_a']")
const rowB = page.locator(".session-entry[data-peek-id='ses_b']")
try {
  await page.goto(preview.url)
  await expect(panel).toContainText("busy · 1m 20s elapsed")
  await expect(panel).toContainText("started ")
  await expect(panel).toContainText("1 user · 2 assistant · 3 tools")
  await expect(panel).toContainText("bash (running)")
  await expect(panel.locator("[data-summary-status='ready']")).toContainText(/summary ready · \d+s old: Reviewing ses_a/)
  expect(calls().length).toBe(1) // no fleet fetch on initial render
  await rowA.hover()
  await expect(card.locator("[data-section='current-work']")).toContainText("Reviewing ses_a")
  expect(calls().length).toBe(1) // panel and hover share the request
  await page.mouse.move(700, 600)
  await rowB.hover()
  await expect(card).toContainText("Reviewing ses_b")
  expect(calls().length).toBe(2)
  await page.mouse.move(700, 600)
  await rowB.hover()
  await expect(card).toContainText("Reviewing ses_b")
  expect(calls().length).toBe(2) // repeated hover cached
  await page.mouse.move(700, 600)
  turn.status = "idle"
  turn.elapsed_seconds = 93
  turn.active_tools = []
  turn.watermark = "b"
  fixture.currentWork = (id, dir) => ({ turn: { ...turn }, summary: { status: "stale", text: `Reviewing ${id}`,
    generated_at: Math.floor(Date.now() / 1000) - 90, watermark: "a" } })
  await page.waitForTimeout(5_200)
  await expect(panel).toContainText("idle · 1m 33s elapsed")
  await expect(panel.locator("[data-summary-status='stale']")).toContainText("summary stale")
  fixture.currentWork = () => ({ status: 503, body: { error: "backend down" } })
  await page.waitForTimeout(30_200)
  await expect(panel).toContainText("refresh failed")
  await expect(panel).toContainText("summary stale")
  await expect(panel).toContainText("telemetry last checked")
  fixture.currentWork = () => ({ turn: { ...turn, status: "unknown", elapsed_seconds: null, user_messages: null,
    assistant_messages: null, tool_calls: null, active_tools: [], watermark: null },
    summary: { status: "error", text: null, generated_at: null, watermark: null } })
  await page.reload()
  await expect(panel).toContainText("unknown · elapsed unknown")
  await expect(panel).toContainText("? user · ? assistant · ? tools")
  await expect(panel.locator("[data-summary-status='error']")).toContainText("summary error")
  fixture.currentWork = undefined
  await page.reload()
  await expect(panel).toContainText("current turn unavailable")
  if (browser) {
    fixture.currentWork = () => ({ turn: { ...turn }, summary: { status: "unavailable", text: null, generated_at: null, watermark: null } })
    const before = calls().length
    const second = await browser.newPage()
    await second.goto(preview.url)
    await expect(second.locator(".session-info [data-section='current-work']")).toContainText("idle · 1m 33s elapsed")
    expect(calls().length).toBe(before + 1) // second tab fetches only its selected session
    await second.close()
  }
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS current work ${app ? "native" : "browser"}: on-demand/dedup, busy/idle, stale/error/unknown/missing, no fleet or mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

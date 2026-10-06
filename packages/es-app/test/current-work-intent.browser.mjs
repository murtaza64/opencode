import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
let attempts = 0
preview.fixture.currentWork = (id, dir, generate) => {
  assert.equal(id, "ses_a")
  assert.equal(dir, directory)
  if (generate === "true") attempts++
  return {
    turn: { started_at: Date.now() - 80_000, elapsed_seconds: 80, status: "busy", user_messages: 1,
      assistant_messages: 1, tool_calls: 1, active_tools: [{ name: "bash", status: "running" }], watermark: "fixture-a" },
    summary: { status: generate === "true" ? "ready" : "unavailable", text: generate === "true" ? "Checking fixture." : null,
      generated_at: generate === "true" ? Math.floor(Date.now() / 1000) : null, watermark: generate === "true" ? "fixture-a" : null },
  }
}
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "current-work-intent-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: preview.fixture.url, ES_DASHBOARD_URL: preview.fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 900 } })
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
try {
  await page.goto(preview.url)
  const panel = page.locator(".session-info [data-section='current-work']")
  await expect(panel).toContainText("1 user · 1 assistant · 1 tools")
  await expect(panel.locator("[data-summary-status='unavailable']")).toBeVisible()
  const calls = () => preview.fixture.calls.filter(call => call.path === "/api/current-work")
  assert.equal(calls().length, 1)
  assert.equal(calls()[0].generate, null)
  assert.equal(attempts, 0)
  await page.reload()
  await expect(panel.locator("[data-summary-status='unavailable']")).toBeVisible()
  assert.equal(attempts, 0) // passive native/session reload cannot invoke the model
  await page.locator(".session-entry[data-peek-id='ses_a']").hover()
  await expect(page.locator(".session-peek [data-summary-status='unavailable']")).toBeVisible()
  assert.equal(attempts, 0)
  await page.locator(".session-peek .current-work-generate").click()
  await expect(page.locator(".session-peek [data-summary-status='ready']")).toContainText("Checking fixture.")
  assert.equal(attempts, 1)
  assert.equal(calls().filter(call => call.generate === "true").length, 1)
  await page.mouse.move(700, 600)
  await page.locator(".session-entry[data-peek-id='ses_a']").hover()
  await expect(page.locator(".session-peek [data-summary-status='ready']")).toBeVisible()
  assert.equal(attempts, 1) // repeated hover shares the ready watermark
  assert.deepEqual(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method)), [])
  console.log(`PASS current work intent ${app ? "native" : "browser"}: passive panel/reload/hover no inference, explicit generate once, zero writes`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const backend = "http://127.0.0.1:7794"
const count = async () => (await (await fetch(`${backend}/fixture-count`)).json()).provider_attempts
assert.equal(await count(), 0, "Disposable backend fixture must be reset before this smoke")
const preview = await startPanelPreview()
preview.fixture.currentWork = async (id, dir, generate) => {
  assert.equal(id, "ses_a")
  assert.equal(dir, directory)
  const response = await fetch(`${backend}/api/current-work?${new URLSearchParams({ session_id: id, directory: dir, ...(generate === "true" ? { generate } : {}) })}`)
  assert.equal(response.status, 200)
  return response.json()
}
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "current-work-live-intent-")) : undefined
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
  assert.equal(await count(), 0)
  assert.deepEqual(preview.fixture.calls.filter(call => call.path === "/api/current-work").map(call => call.generate), [null])
  await page.reload()
  await expect(panel.locator("[data-summary-status='unavailable']")).toBeVisible()
  assert.equal(await count(), 0)
  await page.locator(".session-entry[data-peek-id='ses_a']").hover()
  await expect(page.locator(".session-peek [data-summary-status='unavailable']")).toBeVisible()
  assert.equal(await count(), 0)
  await page.locator(".session-peek .current-work-generate").click()
  await expect(page.locator(".session-peek [data-summary-status='ready']")).toContainText("summary ready", { timeout: 15_000 })
  assert.equal(await count(), 1)
  assert.equal(preview.fixture.calls.filter(call => call.path === "/api/current-work" && call.generate === "true").length, 1)
  await page.mouse.move(700, 600)
  await page.locator(".session-entry[data-peek-id='ses_a']").hover()
  await expect(page.locator(".session-peek [data-summary-status='ready']")).toBeVisible()
  assert.equal(await count(), 1)
  assert.deepEqual(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method)), [])
  console.log(`PASS combined passive/intent ${app ? "native" : "browser"}: backend fixture passive0, explicit generate1, cached ready, zero writes`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

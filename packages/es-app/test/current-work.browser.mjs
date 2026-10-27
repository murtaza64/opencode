import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.currentWork = () => { throw new Error("Current turn endpoint must not be requested by session info or hover") }
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
try {
  await page.goto(preview.url)
  await expect(page.locator(".session-info [data-section='context']")).toBeVisible()
  await expect(page.locator(".session-info [data-section='current-work']")).toHaveCount(0)
  await expect(page.locator(".session-info")).not.toContainText("Generate summary")
  await page.locator(".session-entry[data-peek-id='ses_a']").hover()
  await expect(page.locator(".session-peek")).toBeVisible()
  await expect(page.locator(".session-peek")).not.toContainText("Generate summary")
  await expect(page.locator(".session-peek .peek-todo-state")).toBeVisible()
  expect(fixture.calls.filter(call => call.path === "/api/current-work")).toEqual([])
  expect(fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS retired current turn ${app ? "native" : "browser"}: sidebar and hover preserve context/TODOs without current-work requests or generation`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
preview.fixture.archived.add("ses_b")
preview.fixture.workspaceSessions.push({ ...session("ses_external"), title: "Other project title", directory: "/another/project" })
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "sidebar-search-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: preview.fixture.url, ES_DASHBOARD_URL: preview.fixture.url, OPENCODE_SERVER_PASSWORD: "" } }) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
const projectState = await (await fetch(`${preview.fixture.url}/api/state`)).json()
projectState.threads = projectState.threads.filter(thread => thread.key !== "ses_external")
await page.route("**/es/api/state?*", route => route.fulfill({ json: projectState }))
const replies = []
const searches = []
await page.route("**/es/api/search?*", route => {
  searches.push(new URL(route.request().url()).searchParams.get("q"))
  replies.push(route)
})
const result = (id, title, dir = directory, parent_id = null) => ({ id, title, directory: dir, parent_id, updated: 2, snippet: "transcript", matches: 1 })
const rows = page.locator(".sidebar .search-result")
const input = page.locator(".sidebar .search-input")
try {
  await page.goto(preview.url)
  await expect(page.locator(".sidebar .nav-item", { hasText: "Composer fixture" })).toHaveCount(1)
  await input.fill("Com")
  await expect(rows.filter({ hasText: "Composer fixture" })).toHaveCount(1, { timeout: 250 })
  await expect(page.locator(".sidebar .nav-item", { hasText: "Other session" })).toHaveCount(0)
  await expect(page.locator(".sidebar .nav-empty", { hasText: "searching transcripts" })).toHaveCount(1)
  await expect.poll(() => replies.length).toBe(1)
  await input.fill("Oth")
  await expect(rows.filter({ hasText: "Other session" })).toHaveCount(1)
  await replies.shift().fulfill({ json: { results: [result("ses_a", "Composer fixture")] } })
  await expect(rows.filter({ hasText: "Composer fixture" })).toHaveCount(0)
  await expect.poll(() => replies.length).toBe(1)
  await replies.shift().fulfill({ json: { results: [result("ses_b", "Other session"), result("ses_x", "Transcript hit"), result("ses_child", "Child hit", directory, "ses_a"), result("ses_else", "Wrong project", "/another/project")] } })
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: "Transcript hit" })).toHaveCount(1)
  await expect(rows.filter({ hasText: "Child hit" })).toHaveCount(1)
  await expect(rows.filter({ hasText: "Wrong project" })).toHaveCount(0)
  await rows.filter({ hasText: "Other session" }).click()
  await expect(page).toHaveURL(/\/session\/ses_b\?/)
  expect(new URL(page.url()).searchParams.get("directory")).toBe(directory)
  await input.fill("Co")
  await expect(rows.filter({ hasText: "Composer fixture" })).toHaveCount(1)
  await expect(page.locator(".sidebar .nav-empty", { hasText: "searching transcripts" })).toHaveCount(0)
  await input.fill("Com")
  await expect.poll(() => replies.length).toBe(1)
  await replies.shift().fulfill({ status: 503, json: { error: "unavailable" } })
  await expect(rows.filter({ hasText: "Composer fixture" })).toHaveCount(1)
  await expect(page.locator(".sidebar .nav-empty", { hasText: "transcript search unavailable" })).toHaveCount(1)
  await page.locator(".es-switcher").selectOption("__all__")
  await input.fill("project title")
  await expect(rows.filter({ hasText: "Other project title" })).toHaveCount(1)
  await expect(rows.filter({ hasText: "Composer fixture" })).toHaveCount(0)
  await input.fill("Chi")
  await expect.poll(() => replies.length).toBe(1)
  await replies.shift().fulfill({ json: { results: [result("ses_child", "Child hit", directory, "ses_a"), result("ses_x", "Transcript hit")] } })
  await expect(rows.filter({ hasText: "Child hit" })).toHaveCount(0)
  await expect(rows.filter({ hasText: "Transcript hit" })).toHaveCount(1)
  await input.press("Escape")
  await expect(rows).toHaveCount(0)
  await expect(page.locator(".sidebar .nav-item", { hasText: "Other session" })).toHaveCount(0)
  await page.locator(".sidebar .archived-toggle", { hasText: "archived" }).click()
  await expect(page.locator(".sidebar .nav-item.archived", { hasText: "Other session" })).toHaveCount(1)
  expect(searches).toEqual(["Com", "Oth", "Com", "Chi"])
  expect(preview.fixture.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS sidebar search ${app ? "native" : "browser"}: immediate titles, pending, stale result, transcript, scope, error, clear; zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

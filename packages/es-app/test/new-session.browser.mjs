import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.workspaceSessions.push({ ...fixture.messages[1].info, id: "ses_workspace", title: "Workspace", directory: "/fixture with spaces/a&b?#/.editspace/lanes/feature/repos/example/app", projectID: "fixture", project: { worktree: "/fixture with spaces/a&b?#/.editspace" }, time: { created: 1, updated: 2 } })
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "new-session-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "", OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const context = app ? app.context() : await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = app ? await app.firstWindow() : await context.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent("/fixture with spaces/a&b?#")}`
}
await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const createCalls = () => fixture.calls.filter(call => call.method === "POST" && call.path === "/session")
const saved = () => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("es-app:composer:"))))
const preserves = (actual, expected) => Object.entries(expected).every(([key, value]) => actual[key] === value)
const shot = async (name) => { if (process.env.NEW_SESSION_SHOTS) await page.screenshot({ path: `${process.env.NEW_SESSION_SHOTS}-${name}.png` }) }
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Existing draft remains here")
  await editor.evaluate(el => el.setSelectionRange(3, 11))
  const button = page.getByRole("button", { name: "New session", exact: true })
  await expect(button).toBeVisible()
  await button.click()
  await expect(page.getByLabel("New session project")).toHaveValue("fixture")
  await expect(page.locator(".new-session-directory")).toContainText("/fixture with spaces/a&b?#")
  await expect(page.getByLabel("New session workspace").locator("option")).toHaveCount(2)
  await page.getByLabel("New session workspace").selectOption(fixture.workspaceSessions[0].directory)
  await expect(page.locator(".new-session-directory")).toContainText("/lanes/feature/repos/example/app")
  await page.getByLabel("New session workspace").selectOption("/fixture with spaces/a&b?#")
  const before = await saved()
  await shot("selected")

  fixture.createMode = "fail"
  await page.getByRole("button", { name: "Create session" }).click()
  await expect(page.getByRole("alert")).toContainText("HTTP 503")
  expect(createCalls()).toHaveLength(1)
  expect(preserves(await saved(), before)).toBe(true)

  fixture.createMode = "lose"
  await page.getByRole("button", { name: "Create session" }).click()
  await expect(page.getByRole("alert")).toContainText("may have been created")
  expect(createCalls()).toHaveLength(2)
  await page.waitForTimeout(100)
  expect(createCalls()).toHaveLength(2)

  fixture.createMode = "hold"
  await page.getByRole("button", { name: "Create session" }).click()
  const pending = page.getByRole("button", { name: "Creating…" })
  await expect(pending).toBeDisabled()
  await pending.click({ force: true })
  expect(createCalls()).toHaveLength(3)
  fixture.createMode = "complete"
  fixture.createReplies.shift()()
  await page.waitForURL(/\/session\/ses_new_1\?directory=/)
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused()
  expect(preserves(await saved(), before)).toBe(true)
  expect(createCalls()[2].directory).toBe("/fixture with spaces/a&b?#")

  await page.locator(".es-switcher").selectOption("__all__")
  await button.click()
  await expect(page.getByLabel("New session project")).toHaveValue("")
  await expect(page.getByRole("button", { name: "Create session" })).toHaveCount(0)
  await page.getByLabel("New session project").selectOption("other")
  await expect(page.locator(".new-session-directory")).toContainText("/other project")
  await shot("all-choice")
  await page.getByRole("button", { name: "Create session" }).click()
  await page.waitForURL(/\/session\/ses_new_2\?directory=/)
  expect(createCalls()[3].directory).toBe("/other project")
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused()

  await page.goto(preview.url)
  await expect(editor).toHaveValue("Existing draft remains here")
  expect(await editor.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([3, 11])

  await page.getByRole("button", { name: "Collapse sidebar" }).click()
  const compact = page.locator(".sidebar-mini").getByRole("button", { name: "New session" })
  await expect(compact).toBeVisible()
  await compact.click()
  await page.locator(".sidebar-mini").getByLabel("New session project").selectOption("other")
  await expect(page.locator(".sidebar-mini .new-session-directory")).toContainText("/other project")
  await shot("compact")
  await page.setViewportSize({ width: 640, height: 780 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await shot("compact-rtl")
  const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(size.scroll).toBeLessThanOrEqual(size.client)
  await compact.click()
  fixture.sessionIDs = []
  fixture.created = []
  await page.goto(preview.origin)
  await expect(page.locator(".sidebar-mini")).toBeVisible()
  await expect(page.locator(".sidebar-mini").getByRole("button", { name: "New session" })).toBeVisible()
  expect(fixture.unexpected).toEqual([])
  console.log(`PASS ${app ? "packaged native" : "browser"} new session: current safe directory, explicit All chooser, confirmed navigation/focus, prior draft/selection, pending duplicate guard, known/uncertain failure, compact control`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

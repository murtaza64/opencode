// #153: the project board is hidden under All. Board navigation disappears
// from the expanded sidebar and the mini rail, and `/` under All renders an
// all-projects landing instead of one project's board.
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
fixture.workspaceSessions.push({ ...session("ses_else"), title: "Other project session", directory: "/other project", time: { created: 1, updated: 4 } })
// registered sidecar worktree resolves to the editspace name; bare fixture sessions fall back to their directory basename
fixture.workspaceSessions.push({ ...session("ses_lane"), title: "Lane session", directory: `${directory}/.editspace/lanes/feature/repos/example/app`,
  project: { worktree: `${directory}/.editspace` }, time: { created: 1, updated: 6 } })
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "board-all-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" } }) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const context = app ? app.context() : await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = app ? await app.firstWindow() : await context.newPage()
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
const mutations = () => fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))
const boardLink = page.locator(".sidebar .board-link")
const miniBoard = page.locator(".sidebar-mini a.mini-item[href='/']")
const landing = page.locator("main.all-landing")
// the page heading portals into the native header under Electron, so locate it by topbar rather than main
const heading = page.locator(".topbar h1")
const projectBoard = page.locator("main:not(.all-landing)")
const shot = async (name) => { if (process.env.BOARD_ALL_SHOTS) await page.screenshot({ path: `${process.env.BOARD_ALL_SHOTS}-${name}.png` }) }
try {
  await page.goto(preview.url, { waitUntil: "domcontentloaded" })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await editor.fill("Draft survives the All landing")
  await expect(boardLink).toBeVisible()
  await expect(boardLink).toHaveText(/board/)

  // Project board at `/`, then switch to All while on it: the landing replaces it in place.
  await boardLink.click()
  await page.waitForURL(`${preview.origin}/`)
  await expect(projectBoard).toBeVisible()
  await expect(heading).toHaveText("fixture")
  await expect(boardLink).toHaveClass(/active/)
  const historyBefore = await page.evaluate(() => history.length)
  await page.locator(".es-switcher").selectOption("__all__")
  await expect(landing).toBeVisible()
  await expect(heading).toHaveText("All projects")
  await expect(projectBoard).toHaveCount(0)
  await expect(boardLink).toHaveCount(0)
  expect(page.url()).toBe(`${preview.origin}/`)
  expect(await page.evaluate(() => history.length)).toBe(historyBefore)
  await expect(page.locator(".sidebar").getByRole("button", { name: "New session", exact: true })).toBeVisible()
  await expect(landing.locator(".all-landing-project")).toHaveCount(3)
  await expect(landing.locator(".all-landing-project h2")).toHaveText([/^fixture/, /^other project/, /^a&b\?#/])
  await expect(landing.getByRole("link", { name: /Composer fixture/ })).toBeVisible()
  await expect(landing.getByRole("link", { name: /Other project session/ })).toBeVisible()
  await expect(landing.locator(".all-landing-project").getByRole("button", { name: /board/ })).toHaveText(["board", "other board", "fixture board"])
  await shot("landing")

  // Mini rail: no board icon under All; New session stays reachable.
  await page.getByRole("button", { name: "Collapse sidebar" }).click()
  await expect(page.locator(".sidebar-mini")).toBeVisible()
  await expect(miniBoard).toHaveCount(0)
  await expect(page.locator(".sidebar-mini").getByRole("button", { name: "New session" })).toBeVisible()
  await page.locator(".sidebar-mini .mini-btn, [aria-label='Expand sidebar']").first().click()

  // Reload under All at `/` still lands, never a single-project board.
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(landing).toBeVisible()
  await expect(heading).toHaveText("All projects")
  await expect(boardLink).toHaveCount(0)

  // Keyboard: the per-project board button selects that project and shows its board at `/`.
  const boardButton = landing.getByRole("button", { name: "fixture board", exact: true })
  await boardButton.focus()
  await page.keyboard.press("Enter")
  await expect(projectBoard).toBeVisible()
  await expect(heading).toHaveText("fixture")
  await expect(boardLink).toBeVisible()
  await expect(boardLink).toHaveClass(/active/)
  await expect(page.locator(".es-switcher")).toHaveValue("fixture")
  expect(page.url()).toBe(`${preview.origin}/`)

  // Back to All, open a session from the landing, draft intact.
  await page.locator(".es-switcher").selectOption("__all__")
  await landing.getByRole("link", { name: /Composer fixture/ }).click()
  await page.waitForURL(/\/session\/ses_a\?directory=/)
  await expect(editor).toHaveValue("Draft survives the All landing")
  await expect(boardLink).toHaveCount(0)
  await expect(miniBoard).toHaveCount(0)
  await page.goBack()
  await expect(landing).toBeVisible()
  await expect(heading).toHaveText("All projects")

  // Mobile + RTL: no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 780 })
  await page.evaluate(() => { document.documentElement.dir = "rtl" })
  await expect(landing).toBeVisible()
  const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect(size.scroll).toBeLessThanOrEqual(size.client)
  await shot("mobile-rtl")
  await page.evaluate(() => { document.documentElement.dir = "ltr" })
  await page.setViewportSize({ width: 1280, height: 900 })

  // Project view keeps its board on both rails.
  await page.locator(".es-switcher").selectOption("fixture")
  await expect(projectBoard).toBeVisible()
  await expect(heading).toHaveText("fixture")
  await expect(boardLink).toBeVisible()
  await page.getByRole("button", { name: "Collapse sidebar" }).click()
  await expect(miniBoard).toBeVisible()
  await expect(miniBoard).toHaveClass(/active/)

  expect(mutations()).toEqual([])
  expect(fixture.unexpected).toEqual([])
  console.log(`PASS ${app ? "packaged native" : "browser"} board under All: sidebar/rail board hidden, in-place All landing at /, project board button, session link, draft, history, mobile RTL, zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const other = { ...session("ses_else"), title: "Other project", directory: "/other project", time: { created: 1, updated: 4 } }
preview.fixture.workspaceSessions.push(other)
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "sidebar-pins-")) : undefined
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
const state = await (await fetch(`${preview.fixture.url}/api/state`)).json()
await page.route("**/es/api/state?*", (route) => route.fulfill({ json: {
  ...state,
  threads: route.request().url().includes("es=other")
    ? state.threads.filter((thread) => thread.key === "ses_else")
    : state.threads.filter((thread) => thread.key !== "ses_else" && !preview.fixture.deleted.has(thread.key)),
} }))
const pinned = page.locator(".sidebar .pinned-section .nav-item")
const active = page.locator(".sidebar > .session-entry .nav-item")
const pin = (title) => page.getByRole("button", { name: `Pin ${title}`, exact: true })
const unpin = (title) => page.getByRole("button", { name: `Unpin ${title}`, exact: true })
try {
  await page.goto(preview.url)
  await expect(active).toHaveCount(2)
  const original = page.url()
  await pin("Other session").click()
  await pin("Composer fixture").focus()
  await page.keyboard.press("Enter")
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  expect(page.url()).toBe(original)
  await expect(active).toHaveCount(0)
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("es-app-sidebar-pins")))).toEqual([
    JSON.stringify([directory, "ses_b"]), JSON.stringify([directory, "ses_a"]),
  ])
  // Updates and attention change independently of pin order.
  state.threads[0].sessions[0].updated = 100
  state.threads[1].sessions[0].updated = 200
  state.attention = [{ type: "question", session: "ses_a" }]
  preview.fixture.emit("fixture.changed", {})
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  await page.reload()
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  await page.locator(".es-switcher").selectOption("__all__")
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  await pin("Other project").click()
  await expect(pinned).toHaveCount(3)
  await page.locator(".es-switcher").selectOption("other")
  await expect(pinned).toHaveText([/Other project/])
  await page.locator(".es-switcher").selectOption("fixture")
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  await page.locator(".search-input").fill("Other")
  await expect(pinned).toHaveCount(0)
  await expect(page.locator(".search-result", { hasText: "Other session" })).toHaveCount(1)
  await page.locator(".search-input").press("Escape")
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  preview.fixture.archived.add("ses_b")
  await page.reload()
  await expect(pinned).toHaveText([/Composer fixture/])
  preview.fixture.archived.delete("ses_b")
  await page.reload()
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  preview.fixture.deleted.add("ses_b")
  await page.reload()
  await expect(pinned).toHaveText([/Composer fixture/])
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("es-app-sidebar-pins")))).toHaveLength(3)
  preview.fixture.deleted.delete("ses_b")
  await page.reload()
  await expect(pinned).toHaveText([/Other session/, /Composer fixture/])
  await page.getByRole("button", { name: "Collapse sidebar" }).click()
  await expect(page.locator(".sidebar-mini .mini-session .mini-pin.pinned")).toHaveCount(2)
  await page.locator(".sidebar-mini .mini-pin.pinned", { hasText: "◆" }).first().focus()
  await page.keyboard.press("Enter")
  expect(page.url()).toBe(original)
  await expect(page.locator(".sidebar-mini .mini-pin.pinned")).toHaveCount(1)
  await page.locator(app ? ".native-header .mini-btn" : ".sidebar-mini > .mini-btn").click()
  await expect(pinned).toHaveText([/Composer fixture/])
  await active.filter({ hasText: "Other session" }).click()
  await expect(page).toHaveURL(/\/session\/ses_b\?/)
  expect(preview.fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  console.log(`PASS sidebar pins ${app ? "native" : "browser"}: stable order, reload, project/All, archive, search, compact keyboard, navigation; zero mutations`)
} finally {
  await app?.close()
  await browser?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

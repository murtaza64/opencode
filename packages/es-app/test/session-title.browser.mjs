import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startPanelPreview } from "./composer-panel-preview.mjs"
import { directory, session } from "./composer-fixture.mjs"

const { chromium, _electron, expect } = createRequire(new URL("../../app/package.json", import.meta.url))("@playwright/test")
const preview = await startPanelPreview()
const fixture = preview.fixture
const profile = process.env.ES_DESKTOP_EXECUTABLE ? await mkdtemp(path.join(tmpdir(), "session-title-")) : undefined
const app = profile ? await _electron.launch({ executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", ES_DESKTOP_USER_DATA: profile, ES_DESKTOP_RENDERER: "",
    OPENCODE_URL: fixture.url, ES_DASHBOARD_URL: fixture.url, OPENCODE_SERVER_PASSWORD: "" },
}) : undefined
const browser = app ? undefined : await chromium.launch({ channel: "chrome", headless: true })
const page = app ? await app.firstWindow() : await browser.newPage({
  viewport: { width: 1440, height: 900 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Electron/33.0.0",
})
if (app) {
  await page.waitForURL("http://127.0.0.1:*/")
  preview.origin = new URL(page.url()).origin
  preview.url = `${preview.origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
}
await page.context().route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort())
const title = () => page.getByRole("button", { name: "Rename session", exact: true })
const input = () => page.getByRole("textbox", { name: "Session title", exact: true })
const patches = () => fixture.calls.filter(call => call.method === "PATCH" && call.body?.title !== undefined)
const navigate = async (id) => {
  await page.locator(`.sidebar a[href*='/session/${id}?']`).first().click()
  await expect(page).toHaveURL(new RegExp(`/session/${id}\\?`))
}
try {
  await page.goto(preview.url)
  await expect(title()).toHaveText("Composer fixture")
  await expect(page.locator(".native-header")).toBeVisible()
  expect(await page.locator(".native-header").evaluate(el => getComputedStyle(el).webkitAppRegion)).toBe("drag")
  expect(await title().evaluate(el => getComputedStyle(el).webkitAppRegion)).toBe("no-drag")
  await title().click()
  await expect(input()).toBeFocused()
  expect(await input().evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 16])
  expect(await input().evaluate(el => getComputedStyle(el).webkitAppRegion)).toBe("no-drag")
  await input().fill("  Renamed fixture  ")
  await input().press("Enter")
  await expect(title()).toHaveText("Renamed fixture")
  await expect(page).toHaveTitle("Renamed fixture")
  await expect(page.locator(".sidebar")).toContainText("Renamed fixture")
  expect(patches()).toHaveLength(1)
  expect(patches()[0]).toMatchObject({ method: "PATCH", path: "/session/ses_a", directory, body: { title: "Renamed fixture" } })
  expect(Object.keys(patches()[0].body)).toEqual(["title"])

  await title().focus()
  await page.keyboard.press("Enter")
  await expect(input()).toBeFocused()
  await input().fill("Keyboard title")
  await input().press("Enter")
  await expect(title()).toHaveText("Keyboard title")
  expect(patches()).toHaveLength(2)
  await title().click()
  await input().fill("Do not save")
  await input().press("Escape")
  await expect(title()).toBeFocused()
  await expect(title()).toHaveText("Keyboard title")
  await title().click()
  await input().fill("   ")
  await input().press("Enter")
  await expect(title()).toHaveText("Keyboard title")
  expect(patches()).toHaveLength(2)

  fixture.rejectRename = true
  await title().click()
  await input().fill("Retry draft")
  await input().press("Enter")
  await expect(page.locator(".session-title").getByRole("alert")).toContainText("Could not rename session")
  await expect(input()).toHaveValue("Retry draft")
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  fixture.sessionTitles.set("ses_a", "Remote title")
  fixture.emit("session.updated", { sessionID: "ses_a", info: { ...session("ses_a"), title: "Remote title" } })
  await expect(page).toHaveTitle("Remote title")
  await expect(input()).toHaveValue("Retry draft")
  fixture.rejectRename = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(title()).toHaveText("Retry draft")
  expect(patches()).toHaveLength(4)

  await title().click()
  await input().fill("Saved on blur")
  await page.getByRole("textbox", { name: "Message", exact: true }).click()
  await expect(title()).toHaveText("Saved on blur")
  expect(patches()).toHaveLength(5)

  await title().click()
  await input().fill("Discard on navigation")
  await navigate("ses_b")
  await expect(title()).toHaveText("Other session")
  expect(patches()).toHaveLength(5)
  await navigate("ses_a")
  await expect(title()).toHaveText("Saved on blur")

  fixture.holdRename = true
  await title().click()
  await input().fill("Slow saved title")
  await input().press("Enter")
  await expect.poll(() => fixture.renameReplies.length).toBe(1)
  await input().press("Enter")
  await expect(input()).toHaveAttribute("readonly", "")
  expect(patches()).toHaveLength(6)
  await navigate("ses_b")
  fixture.holdRename = false
  fixture.renameReplies.shift()()
  await expect(title()).toHaveText("Other session")
  await expect(page).toHaveTitle("Other session")
  expect(patches().map(call => call.path)).toEqual(Array(6).fill("/session/ses_a"))
  await navigate("ses_a")
  await expect(title()).toHaveText("Slow saved title")

  for (const [lang, dir, text] of [["en", "ltr", "English 123"], ["en", "rtl", "English forced RTL"], ["ar", "rtl", "جلسة عربية ١٢٣"], ["ar", "rtl", "جلسة README.md 123 /tmp/code"]]) {
    await page.evaluate(({ lang, dir }) => { document.documentElement.lang = lang; document.documentElement.dir = dir }, { lang, dir })
    await title().click()
    await input().fill(text)
    await input().press("Enter")
    await expect(title()).toHaveText(text)
    await expect(title()).toHaveAttribute("dir", "auto")
    expect(await title().evaluate(el => getComputedStyle(el).textAlign)).toBe("start")
    expect(await page.locator(".native-header-safe").evaluate(el => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(84)
  }
  await title().click()
  await input().fill("جلسة mixed README.md 123 /tmp/code — a long session title that must remain reachable at narrow window widths")
  await input().press("Enter")
  if (app) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 800))
  if (!app) await page.setViewportSize({ width: 640, height: 800 })
  await expect(title()).toBeVisible()
  expect(await title().evaluate(el => {
    const box = el.getBoundingClientRect()
    return box.left >= 84 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth
  })).toBe(true)
  await title().click()
  await expect(input()).toBeFocused()
  await input().press("Escape")
  expect(fixture.calls.filter(call => call.method === "POST" && /input|prompt|aside/.test(call.path))).toHaveLength(0)
  expect(fixture.unexpected).toEqual([])
  console.log("PASS session-title: rename, keyboard, cancel, empty, retry, remote update, blur, navigation, slow save, native CSS, RTL")
} catch (error) {
  console.error("Rename requests", patches(), "titles", [...fixture.sessionTitles], "pending", fixture.renameReplies.length)
  throw error
} finally {
  await browser?.close()
  await app?.close()
  await preview.close()
  if (profile) await rm(profile, { recursive: true, force: true })
}

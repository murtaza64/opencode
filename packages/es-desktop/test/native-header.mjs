import { _electron, expect } from "@playwright/test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const root = path.resolve(import.meta.dirname, "..")
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "editspace-header-"))
const artifacts = path.join(root, "artifacts/header")
await mkdir(artifacts, { recursive: true })
const app = await _electron.launch({
  executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  args: process.env.ES_DESKTOP_EXECUTABLE ? [] : [root],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_URL: fixture.url,
    ES_DASHBOARD_URL: fixture.url,
    OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile,
    ES_DESKTOP_RENDERER: "",
  },
})
const result = { profile, nativePID: app.process().pid, fixture: fixture.url, checks: [] }
const check = (text) => {
  result.checks.push(text)
  console.info(`PASS ${text}`)
}
try {
  const page = await app.firstWindow()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  result.origin = origin
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(profile)
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  const header = page.getByRole("banner", { name: "Application header" })
  const editor = page.getByRole("textbox", { name: "Message", exact: true })
  await expect(header).toBeVisible()
  await expect(header.getByRole("heading")).toHaveText("Composer fixture")
  await expect(header.getByRole("combobox", { name: "Project", exact: true })).toBeVisible()
  expect(
    await header.evaluate(
      (node) => !!(node.compareDocumentPosition(document.querySelector(".shell")) & Node.DOCUMENT_POSITION_FOLLOWING),
    ),
  ).toBe(true)
  await expect(page.locator(".session-main > .topbar, .sidebar-top")).toHaveCount(0)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition())).toEqual(
    { x: 12, y: 14 },
  )
  expect(
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return window.getBounds().height - window.getContentBounds().height
    }),
  ).toBe(0)
  expect(await header.evaluate((node) => getComputedStyle(node).webkitAppRegion)).toBe("drag")
  for (const control of await header.locator("button,select,a").all()) {
    expect(await control.evaluate((node) => getComputedStyle(node).webkitAppRegion)).toBe("no-drag")
  }
  await editor.fill("Header fixture draft — preserve across window operations")
  await editor.evaluate((node) => node.setSelectionRange(2, 8))
  await editor.press("Meta+m")
  await expect(page.locator('.direct-submit-actions [data-keyboard-target="true"]')).toHaveAttribute(
    "aria-label",
    "Queue",
  )
  expect(await editor.evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([2, 8])
  expect(
    await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()
          .items.find((item) => item.role === "windowmenu")
          .submenu.items.find((item) => item.role === "minimize").accelerator,
    ),
  ).toBe("")
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false)
  check("one integrated header, native traffic-light inset, no titlebar band, no-drag controls, Cmd+M target cycle")

  for (const variant of [
    { dir: "ltr", lang: "en", width: 1440, zoom: 1 },
    { dir: "rtl", lang: "en", width: 1440, zoom: 1 },
    { dir: "rtl", lang: "ar", width: 640, zoom: 1 },
    { dir: "ltr", lang: "en", width: 1000, zoom: 0.8 },
    { dir: "rtl", lang: "ar", width: 1000, zoom: 1.25 },
  ]) {
    await app.evaluate(({ BrowserWindow }, value) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(value.width, 800)
      window.webContents.setZoomFactor(value.zoom)
    }, variant)
    await page.evaluate((value) => {
      document.documentElement.dir = value.dir
      document.documentElement.lang = value.lang
      if (value.lang === "ar")
        document.querySelector(".native-header h1").textContent =
          "جلسة اختبار — mixed RTL/LTR identity / path with a long session title"
    }, variant)
    await header.getByRole("button", { name: "Collapse sidebar", exact: true }).click()
    await expect(page.locator("nav.sidebar-mini")).toBeVisible()
    await header.getByRole("button", { name: "Expand sidebar", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(page.locator("nav.sidebar:not(.sidebar-mini)")).toBeVisible()
    const geometry = await header.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const project = node.querySelector("select").getBoundingClientRect()
      return {
        top: box.top,
        height: box.height,
        contentTop: document.querySelector(".shell").getBoundingClientRect().top,
        projectX: project.x,
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
        controls: [...node.querySelectorAll("button,select,a")]
          .filter((el) => el.getClientRects().length)
          .map((el) => {
            const rect = el.getBoundingClientRect()
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              reachable: hit === el || el.contains(hit),
            }
          }),
      }
    })
    expect(geometry.top).toBe(0)
    expect(geometry.height).toBeGreaterThanOrEqual(44)
    expect(geometry.contentTop).toBeCloseTo(geometry.height, 0)
    expect(geometry.noOverflow).toBe(true)
    for (const control of geometry.controls) {
      expect(control.left * variant.zoom).toBeGreaterThanOrEqual(80)
      expect(control.top).toBeGreaterThanOrEqual(0)
      expect(control.bottom).toBeLessThanOrEqual(geometry.height)
      expect(control.reachable).toBe(true)
    }
    await expect(editor).toHaveValue("Header fixture draft — preserve across window operations")
    await page.screenshot({ path: path.join(artifacts, `header-${variant.dir}-${variant.lang}-${variant.zoom}.png`) })
  }
  check("LTR/RTL and Arabic mixed text; 640px resize, collapsed sidebar, 80%/125% zoom, pointer/keyboard hit zones")

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setZoomFactor(1)
    window.setSize(1440, 960)
    window.minimize()
  })
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
    .toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
    .toBe(false)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true))
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()))
    .toBe(true)
  await expect(header.getByRole("combobox", { name: "Project", exact: true })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false))
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()))
    .toBe(false)
  await expect(editor).toHaveValue("Header fixture draft — preserve across window operations")
  check("native minimize/restore/fullscreen and draft preservation")
  await page.evaluate(() => {
    document.documentElement.dir = "ltr"
    document.documentElement.lang = "en"
  })
  await page.goto(origin)
  await expect(header.getByRole("heading")).toHaveText("fixture")
  await expect(header.getByRole("button", { name: "refresh", exact: true })).toBeVisible()
  await expect(page.locator("main > header.topbar")).toHaveCount(0)
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await expect(header.getByRole("heading")).toHaveText("Composer fixture")
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => call.method !== "GET")).toEqual([])
  check("session/board header routing; no fixture writes, errors or submissions")
  const windowID = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMediaSourceId().split(":")[1],
  )
  try {
    execFileSync("/usr/sbin/screencapture", ["-x", "-l", windowID, path.join(artifacts, "native-window.png")])
    result.nativeWindowScreenshot = true
  } catch {
    result.nativeWindowScreenshot = false
  }
  result.passed = true
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify(result, null, 2))
  if (process.argv.includes("--preview")) {
    console.info(
      `Isolated native preview: PID ${app.process().pid}; controller ${process.pid}; ${origin}; fixture ${fixture.url}. Close window to stop.`,
    )
    await new Promise((resolve) => app.on("close", resolve))
  }
} finally {
  await app.close().catch(() => {})
  await fixture.close()
  await rm(profile, { recursive: true, force: true })
}

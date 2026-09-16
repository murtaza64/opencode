import { _electron, expect } from "@playwright/test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"
import { createRenderer } from "../scripts/renderer.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-desktop-smoke-"))
const artifacts = path.join(root, "artifacts")
await mkdir(artifacts, { recursive: true })
expect(["4096", "7777", "57041", "57042"]).not.toContain(new URL(fixture.url).port)
const providers = await (await fetch(`${fixture.url}/config/providers`)).json()
expect(providers.default).toEqual({ fixture: "test" })
const vite = process.env.ES_DESKTOP_TEST_DEV ? await createRenderer() : undefined
await vite?.listen()
const renderer = vite ? `http://127.0.0.1:${vite.httpServer.address().port}` : ""
if (renderer) {
  expect(
    (await fetch(`${renderer}/__open-in-editor?file=${encodeURIComponent(path.join(profile, "decoy.txt"))}`)).status,
  ).toBe(403)
  expect((await fetch(`${renderer}/oc/session`)).status).toBe(404)
  expect(
    (await fetch(`${renderer}/__OPEN-IN-EDITOR?file=${encodeURIComponent(path.join(profile, "decoy.txt"))}`)).status,
  ).toBe(403)
}
const launch = {
  ...(process.env.ES_DESKTOP_EXECUTABLE
    ? { executablePath: process.env.ES_DESKTOP_EXECUTABLE, args: [] }
    : { args: [root] }),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_URL: fixture.url,
    ES_DASHBOARD_URL: fixture.url,
    OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile,
    ES_DESKTOP_RENDERER: renderer,
  },
}
const app = await _electron.launch(launch)
try {
  const page = await app.firstWindow()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForURL("http://127.0.0.1:*/")
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  const active = page.locator(".float-editor").or(page.locator(".prompt-box:not([inert])"))
  await expect(active.getByRole("radio", { name: "Queue", exact: true })).toHaveAttribute("aria-checked", "true")
  expect(
    await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return {
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
        webviewTag: prefs.webviewTag,
        preload: prefs.preload,
      }
    }),
  ).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, preload: undefined })
  expect(await page.evaluate(() => [typeof window.require, typeof window.process, typeof window.api])).toEqual([
    "undefined",
    "undefined",
    "undefined",
  ])
  expect((await fetch(origin)).status).toBe(403)
  expect(await page.evaluate(() => fetch("/oc/pty", { method: "POST" }).then((res) => res.status))).toBe(403)
  await expect(active.getByRole("combobox", { name: "Queue agent", exact: true })).toBeEnabled()
  await active.getByRole("combobox", { name: "Queue agent", exact: true }).selectOption("plan")
  await active.locator("textarea").fill("Electron fixture queue")
  await active.getByRole("button", { name: "Queue message", exact: true }).click()
  await expect(page.locator(".input-receipts")).toContainText("Electron fixture queue")
  expect(fixture.receipts).toHaveLength(1)
  expect(fixture.receipts[0].agent).toBe("plan")
  await page.screenshot({ path: path.join(artifacts, "native-session.png") })
  fixture.setStatus("idle")
  await expect(page.getByRole("button", { name: "Use normal Send", exact: true })).toBeVisible()
  expect(fixture.calls.find((call) => call.path.endsWith("/input") && call.method === "POST").directory).toBe(directory)

  // Stub only the OS boundary: exercise the actual native link handlers without opening a browser.
  await app.evaluate(({ app, dialog, shell }) => {
    app.linkChecks = { dialogs: [], opened: [], response: 0 }
    dialog.showMessageBox = async (_window, options) => {
      app.linkChecks.dialogs.push(options)
      return { response: app.linkChecks.response, checkboxChecked: false }
    }
    shell.openExternal = async (url) => {
      app.linkChecks.opened.push(url)
    }
  })
  await page.evaluate(() => window.open("file:///tmp/es-desktop-decoy"))
  await page.evaluate(() => window.open("ink://open"))
  await page.evaluate(() => window.open("https://example.com/review"))
  await expect.poll(() => app.evaluate(({ app }) => app.linkChecks.dialogs.length)).toBe(1)
  expect(await app.evaluate(({ app }) => app.linkChecks.opened)).toEqual([])
  expect(await app.evaluate(({ app }) => app.linkChecks.dialogs[0].defaultId)).toBe(0)
  await app.evaluate(({ app }) => {
    app.linkChecks.response = 1
  })
  await page.evaluate(() => {
    window.location.href = "https://example.com/approved"
  })
  await expect.poll(() => app.evaluate(({ app }) => app.linkChecks.opened)).toEqual(["https://example.com/approved"])
  expect(new URL(page.url()).origin).toBe(origin)
  expect(app.windows()).toHaveLength(1)
  await page.evaluate(() => {
    window.location.href = "/oc/session"
  })
  await expect.poll(() => page.url()).toMatch(/\/session\/ses_a\?/)
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isLoading()))
    .toBe(false)
  expect(await page.evaluate(() => Notification.requestPermission())).toBe("denied")
  expect(
    await page.evaluate(() =>
      fetch("https://example.com/blocked").then(
        () => false,
        () => true,
      ),
    ),
  ).toBe(true)
  expect(
    await page.evaluate(async () => {
      await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
      return true
    }),
  ).toBe(true)
  // Electron-cancelled navigation leaves Playwright's pending-navigation bookkeeping set.
  await page.goto(`${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`)
  await page.evaluate(() => {
    document.documentElement.dir = "rtl"
  })
  await expect(active.locator("textarea")).toBeVisible()
  await page.screenshot({ path: path.join(artifacts, "native-rtl.png") })
  expect(errors).toEqual([])
  await page.evaluate(() => localStorage.setItem("es-app-left-open", "0"))
  console.info(
    "PASS native UI, sandbox, queue/API/SSE, protected loopback, navigation, safe links, denied permissions, WASM, RTL",
  )

  await fixture.close()
  await page.reload()
  await expect(page.getByRole("heading", { name: "Services unavailable" })).toBeVisible()
  await expect(page.getByRole("link", { name: "retry connection" })).toBeVisible()
  await page.screenshot({ path: path.join(artifacts, "native-offline.png") })
  await app.close()
  await expect
    .poll(() =>
      fetch(origin).then(
        () => false,
        () => true,
      ),
    )
    .toBe(true)
  console.info("PASS offline view and shutdown listener cleanup")
  const restarted = await _electron.launch(launch)
  try {
    const page = await restarted.firstWindow()
    await page.waitForURL(`${origin}/`)
    await expect(page.getByRole("heading", { name: "Services unavailable" })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem("es-app-left-open"))).toBe("0")
    console.info("PASS stable origin and preferences after process restart")
  } finally {
    await restarted.close()
  }
} finally {
  await app.close().catch(() => {})
  await fixture.close().catch(() => {})
  await vite?.close()
  await rm(profile, { recursive: true, force: true })
}

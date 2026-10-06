import { _electron, expect } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createFixture, directory } from "../../es-app/test/composer-fixture.mjs"

const fixture = await createFixture()
const profile = await mkdtemp(path.join(tmpdir(), "es-events-windows-"))
const app = await _electron.launch({
  executablePath: process.env.ES_DESKTOP_EXECUTABLE,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    OPENCODE_URL: fixture.url,
    ES_DASHBOARD_URL: fixture.url,
    OPENCODE_SERVER_PASSWORD: "",
    ES_DESKTOP_USER_DATA: profile,
  },
})
try {
  const first = await app.firstWindow()
  const origin = new URL(first.url()).origin
  const url = `${origin}/session/ses_a?directory=${encodeURIComponent(directory)}`
  const second = await app.evaluate(async ({ BrowserWindow, session }, origin) => {
    const window = new BrowserWindow({ show: false, webPreferences: {
      session: session.fromPartition("persist:editspace"), sandbox: true, contextIsolation: true, nodeIntegration: false,
    } })
    await window.loadURL(origin)
    return window.id
  }, origin)
  const pages = [first, (await app.windows()).find((page) => page !== first)]
  expect(pages[1]).toBeTruthy()
  const sockets = pages.map(() => new Map())
  const errors = []
  await Promise.all(pages.map(async (page) => {
    await page.addInitScript(() => {
      window.__sockets = []
      const Native = window.WebSocket
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args)
          window.__sockets.push(this)
        }
      }
    })
  }))
  pages.forEach((page, i) => {
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("websocket", (socket) => {
      const name = new URL(socket.url()).pathname
      if (!["/oc/global/event", "/es/api/notification-events"].includes(name)) errors.push(`unknown socket ${name}`)
      sockets[i].set(socket, name)
      socket.on("close", () => sockets[i].delete(socket))
      socket.on("socketerror", (error) => errors.push(error))
    })
  })
  await Promise.all(pages.map((page) => page.goto(url, { waitUntil: "domcontentloaded" })))
  await Promise.all(pages.map((page) => expect(page.getByText("permission: bash").first()).toBeVisible({ timeout: 30000 })))
  await Promise.all(pages.map((page) => expect(page.locator(".session-page .transcript")).toBeVisible({ timeout: 30000 })))
  await Promise.all(pages.map((page) => expect.poll(() => page.locator("body").innerText().then((text) => !/Session connection lost|Activity connection lost|Unable to load session|Could not load session relationships/.test(text)), { timeout: 10000 }).toBe(true)))
  const expectedSockets = [
    ["/es/api/notification-events", "/oc/global/event"],
    ["/es/api/notification-events", "/oc/global/event"],
  ]
  await expect.poll(() => Promise.all(pages.map((page) => page.evaluate(() => window.__sockets.filter((socket) => socket.readyState === WebSocket.OPEN).map((socket) => new URL(socket.url).pathname).sort()))), { timeout: 10000 }).toEqual(expectedSockets)
  await first.reload({ waitUntil: "domcontentloaded" })
  await expect(first.getByText("permission: bash").first()).toBeVisible({ timeout: 30000 })
  await expect.poll(() => first.evaluate(() => window.__sockets.filter((socket) => socket.readyState === WebSocket.OPEN).map((socket) => new URL(socket.url).pathname).sort()), { timeout: 10000 }).toEqual(expectedSockets[0])
  expect(errors).toEqual([])
  expect(fixture.calls.filter((call) => !["GET", "HEAD", "OPTIONS"].includes(call.method))).toEqual([])
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), second)
  console.log("PASS packaged Electron two windows: two event sockets/window, no banners, permission and transcript, reconnect, zero mutations")
} finally {
  await app.close().catch(() => {})
  await fixture.close()
  await rm(profile, { recursive: true, force: true })
}

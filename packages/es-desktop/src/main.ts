import { app, BrowserWindow, dialog, Menu, session, shell } from "electron"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { serve } from "./server"
import { externalURL, internalURL } from "./policy"

app.setName("Editspace")
app.setPath("userData", process.env.ES_DESKTOP_USER_DATA ?? path.join(app.getPath("appData"), "Editspace"))
app.enableSandbox()

const start = async () => {
  if (!app.requestSingleInstanceLock()) return app.quit()
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  await app.whenReady()
  // Stable origin preserves es-app localStorage; preview/test profiles remain disposable.
  const portFile = path.join(app.getPath("userData"), "loopback-port")
  const saved = Number(await readFile(portFile, "utf8").catch(() => "0"))
  const port = Number.isInteger(saved) && saved >= 1024 && saved <= 65535 && ![4096, 7777].includes(saved) ? saved : 0
  const server = await serve({
    port,
    root: path.join(app.getAppPath(), "dist/renderer"),
    opencode: process.env.OPENCODE_URL,
    dashboard: process.env.ES_DASHBOARD_URL,
    opencodeAuth: process.env.OPENCODE_SERVER_PASSWORD
      ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
      : undefined,
    renderer: app.isPackaged ? undefined : process.env.ES_DESKTOP_RENDERER,
  })
  await writeFile(portFile, new URL(server.origin).port, { mode: 0o600 })
  const isolated = session.fromPartition("persist:editspace")
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.on("will-download", (event) => event.preventDefault())
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: new URL(details.url).origin !== server.origin })
  })
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    // The renderer never receives the capability protecting the loopback listener.
    if (new URL(details.url).origin === server.origin) details.requestHeaders["x-editspace-key"] = server.key
    callback({ requestHeaders: details.requestHeaders })
  })
  const window = new BrowserWindow({
    title: "Editspace",
    width: 1440,
    height: 960,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#171819",
    show: false,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 12, y: 14 },
          titleBarOverlay: { height: 44 },
        }
      : {}),
    webPreferences: {
      session: isolated,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  })
  if (process.platform === "darwin")
    window.webContents.on("did-finish-load", () => {
      void window.webContents.insertCSS(
        "body:not(:has(#root))::before { content: ''; position: fixed; top: 0; left: 84px; right: 0; height: 44px; -webkit-app-region: drag; }",
      )
    })
  const openExternal = async (value: string) => {
    const url = externalURL(value)
    if (!url || window.isDestroyed()) return
    await shell.openExternal(url)
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(() => console.error("External browser unavailable"))
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (internalURL(url, server.origin)) return
    event.preventDefault()
    if (new URL(url).origin !== server.origin)
      void openExternal(url).catch(() => console.error("External browser unavailable"))
  })
  window.webContents.on("will-redirect", (event, url) => {
    if (!internalURL(url, server.origin)) event.preventDefault()
  })
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) event.preventDefault()
  })
  window.webContents.on("will-attach-webview", (event) => event.preventDefault())
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        role: "viewMenu",
        submenu: [
          { role: "reload" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
      {
        role: "windowMenu",
        // Reserve Command+M for the composer's target cycle, retaining the menu action.
        submenu:
          process.platform === "darwin"
            ? [{ role: "minimize", accelerator: "" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
            : undefined,
      },
    ]),
  )
  const state = { closing: false }
  app.on("before-quit", (event) => {
    if (state.closing) return
    event.preventDefault()
    state.closing = true
    isolated.flushStorageData()
    void server.close().finally(() => app.quit())
  })
  app.on("window-all-closed", () => app.quit())
  process.on("SIGTERM", () => app.quit())
  process.on("SIGINT", () => app.quit())
  await window.loadURL(server.origin)
  window.show()
  console.info(`Editspace listening at ${server.origin} (native session only)`)
}

void start().catch((error: unknown) => {
  console.error("Editspace startup failed", { message: error instanceof Error ? error.message : "Unknown error" })
  dialog.showErrorBox(
    "Editspace could not start",
    "Check service origins and the renderer build. If the saved loopback port is occupied, retry after it becomes free. No attached service was started or stopped.",
  )
  app.exit(1)
})

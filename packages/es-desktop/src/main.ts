import { app, BrowserWindow, dialog, Menu, session, shell } from "electron"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { serve } from "./server"
import { appRouteURL, externalURL, internalURL, serviceOrigins, startupMode, startupPlan } from "./policy"

app.setName("Editspace")
app.setPath("userData", process.env.ES_DESKTOP_USER_DATA ?? path.join(app.getPath("appData"), "Editspace"))
app.enableSandbox()
const startup = startupPlan(startupMode(process.env.ES_DESKTOP_START))
// Set before the app finishes launching so the opt-in start does not request activation or a dock icon.
if (process.platform === "darwin" && startup.activationPolicy) app.setActivationPolicy(startup.activationPolicy)
const opened = { ready: false, requested: false }
// Reveal a background start: a second launch may arrive before load and is queued; it then becomes regular.
const reveal = () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window || !opened.ready) {
    opened.requested = true
    return
  }
  if (process.platform === "darwin") app.setActivationPolicy("regular")
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

const start = async () => {
  if (!app.requestSingleInstanceLock()) return app.quit()
  app.on("second-instance", () => {
    if (startup.activationPolicy) {
      if (startup.revealOnReopen) reveal()
      return
    }
    const window = BrowserWindow.getAllWindows()[0]
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  // `activate` also fires for the initial launch, so it is ignored (never queued) until the window
  // has loaded; only a later reopen of the running app reveals it.
  if (startup.revealOnReopen && startup.activationPolicy)
    app.on("activate", () => {
      if (opened.ready) reveal()
    })
  await app.whenReady()
  // Stable origin preserves es-app localStorage; preview/test profiles remain disposable.
  const portFile = path.join(app.getPath("userData"), "loopback-port")
  const saved = Number(await readFile(portFile, "utf8").catch(() => "0"))
  const port = Number.isInteger(saved) && saved >= 1024 && saved <= 65535 && ![4096, 7777].includes(saved) ? saved : 0
  const origins = await serviceOrigins(app.getPath("userData"), {
    OPENCODE_URL: process.env.OPENCODE_URL,
    ES_DASHBOARD_URL: process.env.ES_DASHBOARD_URL,
  })
  const server = await serve({
    port,
    root: path.join(app.getAppPath(), "dist/renderer"),
    opencode: origins.opencode,
    dashboard: origins.dashboard,
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
  const local = (value: string) => {
    const url = new URL(value)
    return url.host === new URL(server.origin).host && ["http:", "ws:"].includes(url.protocol)
  }
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !local(details.url) })
  })
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    // The renderer never receives the capability protecting the loopback listener.
    if (local(details.url)) details.requestHeaders["x-editspace-key"] = server.key
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
      backgroundThrottling: startup.backgroundThrottling,
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
    // The renderer navigates plain clicks on app links itself; this covers new-window opens of app routes.
    const route = appRouteURL(url, server.origin)
    if (route) void window.loadURL(route)
    else void openExternal(url).catch(() => console.error("External browser unavailable"))
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (internalURL(url, server.origin)) return
    event.preventDefault()
    const route = appRouteURL(url, server.origin)
    if (route) void window.loadURL(route)
    else if (new URL(url).origin !== server.origin)
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
  opened.ready = true
  if (startup.showOnLoad) window.show()
  else if (opened.requested) reveal()
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

import { app, BaseWindow, BrowserWindow, dialog, Menu, nativeImage, session, shell, systemPreferences } from "electron"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { serve } from "./server"
import { PERF_DIR } from "./perf-log"
import { createVoice, voiceTools } from "./voice"
import { appRouteURL, externalURL, internalURL, pageNavigation, serviceHosts, serviceOrigins, startupMode, startupPlan, surfaceFrameURL } from "./policy"
import { createTabs, TITLE_BAR_HEIGHT } from "./tabs"
import { watchBadges } from "./badges"
import { createAppearance } from "./appearance"

app.setName("Editspace")
app.setPath("userData", process.env.ES_DESKTOP_USER_DATA ?? path.join(app.getPath("appData"), "Editspace"))
app.enableSandbox()
const startup = startupPlan(startupMode(process.env.ES_DESKTOP_START))
// Set before the app finishes launching so the opt-in start does not request activation or a dock icon.
if (process.platform === "darwin" && startup.activationPolicy) app.setActivationPolicy(startup.activationPolicy)
const opened = { ready: false, requested: false }
// Reveal a background start: a second launch may arrive before load and is queued; it then becomes regular.
const reveal = () => {
  const window = BaseWindow.getAllWindows()[0]
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
    const window = BaseWindow.getAllWindows()[0]
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
  const voice = createVoice({
    resolve: () =>
      voiceTools({ home: app.getPath("home"), env: process.env, config: path.join(app.getPath("userData"), "voice.json") }),
    // Capture runs in a SoX child; macOS attributes it to Editspace, so ask through the app first.
    permission: async () => {
      if (process.platform !== "darwin") return true
      const access = systemPreferences.getMediaAccessStatus("microphone")
      if (access === "granted") return true
      if (access !== "not-determined") return false
      // Hidden starts are automated verification: never raise the system prompt there. The OS
      // still gates a real recorder; fixture recorders need no microphone.
      if (startupMode(process.env.ES_DESKTOP_START) === "hidden") return true
      return systemPreferences.askForMediaAccess("microphone")
    },
    temp: app.getPath("temp"),
    openSettings:
      process.platform === "darwin"
        ? () => shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        : undefined,
  })
  const appearance = createAppearance({
    directory: process.env.ES_APPEARANCE_DIR ?? path.join(app.getPath("home"), ".cache/wal"),
    // Shrinking to a few dozen pixels and scaling back up gives a soft blur without an image library.
    blur: async (file) => {
      const image = nativeImage.createFromPath(file)
      if (image.isEmpty()) throw new Error("Not an image")
      return image.resize({ width: 24, quality: "good" }).resize({ width: 640, quality: "best" }).toJPEG(70)
    },
  })
  const server = await serve({
    appearance,
    port,
    root: path.join(app.getAppPath(), "dist/renderer"),
    opencode: origins.opencode,
    dashboard: origins.dashboard,
    opencodeAuth: process.env.OPENCODE_SERVER_PASSWORD
      ? `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
      : undefined,
    renderer: app.isPackaged ? undefined : process.env.ES_DESKTOP_RENDERER,
    voice,
    perfDir: PERF_DIR,
  })
  await writeFile(portFile, new URL(server.origin).port, { mode: 0o600 })
  // Each remote execution host gets its own keyed loopback listener on a stable saved port, so its
  // origin (and with it storage, drafts and receipts) stays separate from local work across launches.
  // Remote host problems never stop local startup: that host is left out and the reason logged.
  const configured = await serviceHosts(app.getPath("userData"), { ES_REMOTE_HOSTS: process.env.ES_REMOTE_HOSTS }).catch((error: unknown) => {
    console.error("Editspace remote hosts ignored", { message: error instanceof Error ? error.message : "Unknown error" })
    return []
  })
  const started = await Promise.all(
    configured.filter((host) => host.mode === "proxy").map(async (host) => {
      const file = path.join(app.getPath("userData"), `loopback-port-${host.id}`)
      const value = Number(await readFile(file, "utf8").catch(() => "0"))
      const listener = await serve({
        port: Number.isInteger(value) && value >= 1024 && value <= 65535 && ![4096, 7777, port].includes(value) ? value : 0,
        root: path.join(app.getAppPath(), "dist/renderer"),
        renderer: app.isPackaged ? undefined : process.env.ES_DESKTOP_RENDERER,
        remote: { id: host.id, origin: host.origin },
        // The look belongs to this laptop, whichever host a tab shows.
        appearance,
        // Host tabs show placement natively, so the page needs no switcher of its own.
        hostInfo: () => ({ id: host.id, label: host.label, remote: true, hosts: [] }),
        perfDir: PERF_DIR,
      })
      await writeFile(file, new URL(listener.origin).port, { mode: 0o600 })
      return { ...host, server: listener }
    }).map((started) => started.catch((error: unknown) => {
      console.error("Editspace remote host listener failed", { message: error instanceof Error ? error.message : "Unknown error" })
      return undefined
    })),
  )
  const remotes = started.filter((item) => item !== undefined)
  const pages = configured.filter((host) => host.mode === "page")
  const listeners = [{ id: "local", label: "Local", server }, ...remotes]
  const isolated = listenerSession("persist:editspace", server)
  const preferences = (partition: Electron.Session): Electron.WebPreferences => ({
    backgroundThrottling: startup.backgroundThrottling,
    session: partition,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  })
  const frame = {
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
          titleBarOverlay: { height: TITLE_BAR_HEIGHT },
        }
      : {}),
  }
  // Without other hosts the window is exactly the local app; with them, host tabs sit above one view per host.
  const window = remotes.length || pages.length ? new BaseWindow(frame) : new BrowserWindow({ ...frame, webPreferences: preferences(isolated) })
  const openExternal = async (value: string) => {
    const url = externalURL(value)
    if (!url || window.isDestroyed()) return
    await shell.openExternal(url)
  }
  const tabs = window instanceof BrowserWindow
    ? undefined
    : createTabs(window, [
        { id: "local", label: "Local", url: server.origin, session: isolated, kind: "app" as const, guard: (contents) => guardListener(contents, server.origin, true) },
        ...remotes.map((host) => ({
          id: host.id,
          label: host.label,
          url: host.server.origin,
          session: listenerSession(`persist:editspace-host-${host.id}`, host.server),
          kind: "app" as const,
          guard: (contents: Electron.WebContents) => guardListener(contents, host.server.origin, false),
        })),
        ...pages.map((host) => ({ id: host.id, label: host.label, url: `${host.origin}/`, session: pageSession(`persist:editspace-host-${host.id}`), kind: "page" as const, guard: (contents: Electron.WebContents) => guardPage(contents, host.origin) })),
      ], preferences)
  const localContents = window instanceof BrowserWindow ? window.webContents : tabs!.contents("local")
  if (process.platform === "darwin")
    localContents.on("did-finish-load", () => {
      if (tabs) return
      void localContents.insertCSS(
        "body:not(:has(#root))::before { content: ''; position: fixed; top: 0; left: 84px; right: 0; height: 44px; -webkit-app-region: drag; }",
      )
    })
  // One host's app listener: same-origin navigation stays; app links to local ports belong to the Local tab.
  function guardListener(contents: Electron.WebContents, origin: string, local: boolean) {
    const open = (url: string) => {
      const route = appRouteURL(url, local ? origin : server.origin)
      if (!route) return false
      if (local) void contents.loadURL(route)
      else {
        tabs?.select("local")
        void localContents.loadURL(route)
      }
      return true
    }
    contents.setWindowOpenHandler(({ url }) => {
      // The renderer navigates plain clicks on app links itself; this covers new-window opens of app routes.
      if (!open(url)) void openExternal(url).catch(() => console.error("External browser unavailable"))
      return { action: "deny" }
    })
    contents.on("will-navigate", (event, url) => {
      if (internalURL(url, origin)) return
      event.preventDefault()
      if (!open(url) && !listeners.some((item) => new URL(item.server.origin).host === URL.parse(url)?.host))
        void openExternal(url).catch(() => console.error("External browser unavailable"))
    })
    contents.on("will-redirect", (event, url) => {
      if (!internalURL(url, origin)) event.preventDefault()
    })
    contents.on("will-frame-navigate", (event) => {
      // Subframes may only show Front Desk surfaces, which the server sandboxes.
      if (!event.isMainFrame && !surfaceFrameURL(event.url, origin)) event.preventDefault()
    })
    contents.on("will-attach-webview", (event) => event.preventDefault())
  }
  // A host's own served page: its origin and its sign-in flow stay in the tab; other links open externally.
  function guardPage(contents: Electron.WebContents, origin: string) {
    contents.setWindowOpenHandler(({ url }) => {
      void openExternal(url).catch(() => console.error("External browser unavailable"))
      return { action: "deny" }
    })
    contents.on("will-navigate", (event, url) => {
      if (pageNavigation(url, origin)) return
      event.preventDefault()
      void openExternal(url).catch(() => console.error("External browser unavailable"))
    })
    contents.on("will-attach-webview", (event) => event.preventDefault())
  }
  if (window instanceof BrowserWindow) guardListener(window.webContents, server.origin, true)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        role: "viewMenu",
        submenu: [
          { role: "reload" },
          // Under host tabs, zoom applies to the shown host and re-fits its header beside the tabs.
          ...(tabs
            ? ([["resetzoom", "Actual Size", "CommandOrControl+0", () => 1], ["zoomin", "Zoom In", "CommandOrControl+Plus", (z: number) => Math.min(3, z + 0.1)], ["zoomout", "Zoom Out", "CommandOrControl+-", (z: number) => Math.max(0.5, z - 0.1)]] as const).map(([id, label, accelerator, next]) => ({
                id,
                label,
                accelerator,
                click: () => {
                  const contents = tabs.shownContents()
                  contents.setZoomFactor(Math.round(next(contents.getZoomFactor()) * 100) / 100)
                  tabs.refresh()
                },
              }))
            : ([{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] as const)),
          { role: "togglefullscreen" },
        ],
      },
      // Host tabs: Cmd+Ctrl+1..9 selects a host; the native menu also reads hosts to VoiceOver.
      ...(tabs
        ? [{
            label: "Hosts",
            submenu: tabs.hosts().slice(0, 9).map((host, index) => ({
              label: host.label,
              accelerator: `${process.platform === "darwin" ? "Command+Control" : "Control+Alt"}+${index + 1}`,
              click: () => tabs.select(host.id),
            })),
          }]
        : []),
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
    appearance.close()
    for (const partition of tabs?.sessions() ?? [isolated]) partition.flushStorageData()
    void voice.close().finally(() => Promise.allSettled(listeners.map((item) => item.server.close()))).finally(() => app.quit())
  })
  app.on("window-all-closed", () => app.quit())
  process.on("SIGTERM", () => app.quit())
  process.on("SIGINT", () => app.quit())
  if (tabs) {
    tabs.select("local")
    // Inactive tabs show each host's open decisions from a small summary read, never a hidden page.
    const stop = watchBadges([
      { id: "local", read: (path) => fetch(`${server.origin}${path}`, { headers: { "x-editspace-key": server.key, origin: server.origin }, redirect: "error", signal: AbortSignal.timeout(10_000) }) },
      ...remotes.map((host) => ({ id: host.id, read: (path: string) => fetch(`${host.server.origin}${path}`, { headers: { "x-editspace-key": host.server.key, origin: host.server.origin }, redirect: "error", signal: AbortSignal.timeout(10_000) }) })),
      // A page host is read with its own partition (its own sign-in), on its own origin, read-only.
      ...pages.map((host) => ({ id: host.id, read: (path: string) => session.fromPartition(`persist:editspace-host-${host.id}`).fetch(`${host.origin}${path}`, { credentials: "include", redirect: "error", signal: AbortSignal.timeout(10_000) }) })),
    ], (id, badge) => tabs.setBadge(id, badge))
    app.on("before-quit", stop)
  }
  await (tabs ? new Promise<void>((resolve) => localContents.once("did-finish-load", () => resolve())) : localContents.loadURL(server.origin))
  opened.ready = true
  if (startup.showOnLoad) window.show()
  else if (opened.requested) reveal()
  console.info(`Editspace listening at ${server.origin} (native session only)`)
  remotes.forEach((item) => console.info(`Editspace ${item.label} listening at ${item.server.origin} (native session only)`))
  pages.forEach((item) => console.info(`Editspace ${item.label} tab shows ${item.origin}`))
}

void start().catch((error: unknown) => {
  console.error("Editspace startup failed", { message: error instanceof Error ? error.message : "Unknown error" })
  dialog.showErrorBox(
    "Editspace could not start",
    "Check service origins and the renderer build. If the saved loopback port is occupied, retry after it becomes free. No attached service was started or stopped.",
  )
  app.exit(1)
})

// A laptop listener's partition: requests reach only that listener, carrying its capability key.
const listenerSession = (partition: string, listener: { origin: string; key: string }) => {
  const result = session.fromPartition(partition)
  const own = (value: string) => {
    const url = URL.parse(value)
    return !!url && ["http:", "ws:"].includes(url.protocol) && url.host === new URL(listener.origin).host
  }
  result.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  result.setPermissionCheckHandler(() => false)
  result.on("will-download", (event) => event.preventDefault())
  result.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !own(details.url) })
  })
  result.webRequest.onBeforeSendHeaders((details, callback) => {
    // The renderer never receives the capability protecting the loopback listener.
    if (own(details.url)) details.requestHeaders["x-editspace-key"] = listener.key
    callback({ requestHeaders: details.requestHeaders })
  })
  return result
}

// A remote page's partition: secure web only, so it can never reach this machine's loopback services.
const pageSession = (partition: string) => {
  const result = session.fromPartition(partition)
  result.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  result.setPermissionCheckHandler(() => false)
  result.on("will-download", (event) => event.preventDefault())
  result.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(https|wss|data|blob):/.test(details.url) })
  })
  return result
}

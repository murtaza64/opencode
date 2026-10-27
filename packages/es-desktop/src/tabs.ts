/* Host tabs: a trusted bar of execution hosts above one isolated view per host. Each view has its
 * own session partition and origin, so drafts, cookies and requests never cross hosts, and a view
 * keeps its page while another host is shown. The bar has no scripts or privileges; selecting a tab
 * is a navigation the main process intercepts. */
import { session, WebContentsView, type BaseWindow, type Session, type WebContents } from "electron"

export type HostTab = {
  id: string
  label: string
  url: string
  session: Session
  // Applies that host's navigation policy to its view.
  guard: (contents: WebContents) => void
}

export const TAB_BAR_HEIGHT = 36
const TAB_URL = "https://editspace-tab.invalid/"

export const createTabs = (
  window: BaseWindow,
  tabs: HostTab[],
  preferences: (partition: Session) => Electron.WebPreferences,
) => {
  const views = new Map<string, WebContentsView>()
  const state = { selected: tabs[0].id }
  const barSession = session.fromPartition("editspace-tab-bar")
  barSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }))
  const bar = new WebContentsView({ webPreferences: { ...preferences(barSession), javascript: false } })
  bar.webContents.on("will-navigate", (event, url) => {
    event.preventDefault()
    if (url.startsWith(TAB_URL)) select(decodeURIComponent(url.slice(TAB_URL.length)))
  })
  bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.contentView.addChildView(bar)
  const layout = () => {
    const bounds = window.getContentBounds()
    bar.setBounds({ x: 0, y: 0, width: bounds.width, height: TAB_BAR_HEIGHT })
    views.forEach((view) => view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: bounds.width, height: Math.max(0, bounds.height - TAB_BAR_HEIGHT) }))
  }
  // Views load on first selection, so an unopened remote host is never contacted at launch.
  const view = (id: string) => {
    const existing = views.get(id)
    if (existing) return existing
    const tab = tabs.find((item) => item.id === id)
    if (!tab) throw new Error(`Unknown host tab ${id}`)
    const created = new WebContentsView({ webPreferences: preferences(tab.session) })
    created.setBackgroundColor("#171819")
    tab.guard(created.webContents)
    views.set(id, created)
    window.contentView.addChildView(created)
    layout()
    void created.webContents.loadURL(tab.url)
    return created
  }
  const paint = () =>
    void bar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barHTML(tabs, state.selected))}`)
  const select = (id: string) => {
    if (!tabs.some((item) => item.id === id)) return
    state.selected = id
    const shown = view(id)
    views.forEach((item) => item.setVisible(item === shown))
    paint()
    shown.webContents.focus()
  }
  window.on("resize", layout)
  return {
    select,
    selected: () => state.selected,
    contents: (id: string) => view(id).webContents,
    sessions: () => [...new Set(tabs.map((tab) => tab.session))],
  }
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const barHTML = (tabs: HostTab[], selected: string) =>
  `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Hosts</title><style>
html,body{margin:0;height:100%;background:#111213;color:#a6adc8;font:600 12px system-ui;-webkit-user-select:none;user-select:none}
nav{display:flex;align-items:stretch;gap:2px;height:100%;padding-inline-start:${process.platform === "darwin" ? 84 : 8}px;-webkit-app-region:drag;box-sizing:border-box;border-block-end:1px solid #2a2b3c}
a{-webkit-app-region:no-drag;display:flex;align-items:center;padding:0 14px;color:inherit;text-decoration:none;border-block-end:2px solid transparent}
a:hover{color:#cdd6f4;background:#1e1e2e}
a[aria-current=page]{color:#cdd6f4;border-block-end-color:#fab387}
</style><nav aria-label="Hosts">${tabs
    .map((tab) => `<a href="${TAB_URL}${encodeURIComponent(tab.id)}"${tab.id === selected ? ' aria-current="page"' : ""}>${escape(tab.label)}</a>`)
    .join("")}</nav></html>`

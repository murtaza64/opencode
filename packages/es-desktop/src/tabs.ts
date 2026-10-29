/* Host tabs: a trusted strip of execution hosts in the window's title bar row, after the window
 * controls, above one isolated view per host. App hosts (es-app) fill the window and their own
 * header continues the same row after the strip, so there is one title bar. Page hosts (another
 * site, e.g. behind Cloudflare Access) sit below a full-width strip so their content is never
 * covered. Each view has its own session partition and origin, so drafts, cookies and requests
 * never cross hosts, and a view keeps its page while another host is shown. The strip has no
 * scripts or privileges; selecting a tab is a navigation the main process intercepts. */
import { Menu, session, WebContentsView, type BaseWindow, type Session, type WebContents } from "electron"

export type HostTab = {
  id: string
  label: string
  url: string
  session: Session
  // App hosts render the es-app header in the title bar row; page hosts get the row to themselves.
  kind: "app" | "page"
  // Applies that host's navigation policy to its view.
  guard: (contents: WebContents) => void
  // The strip tab whose view already shows this host's rows (the Work view for a proxied Work host).
  // Such a host is opened from the Hosts menu; it joins the strip only while shown, and its decision
  // count rides on that tab.
  within?: string
}

/** A host's decision count for its inactive tab: a number, or unavailable when it cannot be read. */
export type Badge = { count: number; partial: boolean } | "unavailable"

// Same height as the es-app native header, so the strip and the app header form one row.
export const TITLE_BAR_HEIGHT = 44
// macOS window controls sit physically left; the strip starts after them in every direction.
const CONTROLS_INSET = process.platform === "darwin" ? 78 : 8
const TAB_URL = "https://editspace-tab.invalid/"
const MENU = "__hosts"
// Below this window width the segment collapses to the current host plus a host menu.
const NARROW = 900

export const createTabs = (
  window: BaseWindow,
  tabs: HostTab[],
  preferences: (partition: Session) => Electron.WebPreferences,
) => {
  const views = new Map<string, WebContentsView>()
  const state = { selected: tabs[0].id, painted: "", queued: false }
  const badges = new Map<string, Badge>()
  const css = new Map<string, { key: string; width: number }>()
  const barSession = session.fromPartition("editspace-tab-bar")
  barSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }))
  const bar = new WebContentsView({ webPreferences: { ...preferences(barSession), javascript: false } })
  // Transparent over app hosts, so the app header (and its bottom border) shows through as one row.
  bar.setBackgroundColor("#00000000")
  bar.webContents.on("will-navigate", (event, url) => {
    event.preventDefault()
    if (!url.startsWith(TAB_URL)) return
    const id = decodeURIComponent(url.slice(TAB_URL.length))
    if (id === MENU) return menu()
    select(id)
  })
  bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.contentView.addChildView(bar)
  const current = () => tabs.find((tab) => tab.id === state.selected) ?? tabs[0]
  const narrow = () => window.getContentBounds().width < NARROW
  const describe = (id: string) => {
    const badge = badges.get(id)
    if (id === state.selected || !badge) return ""
    if (badge === "unavailable") return " · Needs you unavailable"
    return badge.count || badge.partial ? ` · ${badge.count}${badge.partial ? "+" : ""} need you` : ""
  }
  // Strip tabs: hosts without a containing tab, plus the shown host so the strip always names it.
  const strip = () => tabs.filter((tab) => !tab.within || tab.id === state.selected)
  // A strip tab's count covers itself and the hosts it contains, except whichever host is shown.
  const shownBadge = (id: string): Badge | undefined => {
    const group = tabs
      .filter((tab) => (tab.id === id || tab.within === id) && tab.id !== state.selected)
      .flatMap((tab) => { const badge = badges.get(tab.id); return badge ? [badge] : [] })
    if (!group.length) return undefined
    const read = group.filter((badge) => badge !== "unavailable")
    if (read.length < group.length) return "unavailable"
    return { count: read.reduce((sum, badge) => sum + badge.count, 0), partial: read.some((badge) => badge.partial) }
  }
  const menu = () =>
    Menu.buildFromTemplate(tabs.map((tab) => ({
      label: `${tab.label}${describe(tab.id)}`,
      type: "radio" as const,
      checked: tab.id === state.selected,
      click: () => select(tab.id),
    }))).popup({ window, x: CONTROLS_INSET, y: TITLE_BAR_HEIGHT })
  // The strip's width over an app host: the window controls plus each tab. Labels are short host
  // names in the system font; the estimate leaves slack rather than clipping.
  const stripWidth = () => narrow()
    ? CONTROLS_INSET + 8 + 20 + Math.min(150, Math.ceil(current().label.length * 7.4)) + 16 + (summary() ? 24 : 0)
    : CONTROLS_INSET + 8 + strip().reduce((sum, tab) => sum + 20 + Math.min(150, Math.ceil(tab.label.length * 7.4)) + (badgeText(tab.id) ? 24 : 0), 0)
  // The app's header starts after the strip, in the same row, keeping its own drag area.
  const inset = async (tab: HostTab, contents: WebContents) => {
    if (tab.kind !== "app" || contents.isLoading()) return
    // CSS pixels: the strip is measured in window points, the page may be zoomed.
    const width = Math.ceil(stripWidth() / (contents.getZoomFactor() || 1))
    const previous = css.get(tab.id)
    if (previous?.width === width) return
    // The in-app host select is redundant under native host tabs.
    const key = await contents
      // The window's drag regions come from this view even where the strip view is layered above it:
      // only the header's own content area (after the strip) drags here, or clicks on host tabs become window drags.
      .insertCSS(`:root{--host-tabs-end:${width}px}.native-header-safe{left:max(84px,${width}px)!important}.host-switch{display:none!important}.native-header{-webkit-app-region:no-drag!important}.native-header-safe{-webkit-app-region:drag}`)
      .catch(() => undefined)
    if (previous) void contents.removeInsertedCSS(previous.key).catch(() => {})
    if (key) css.set(tab.id, { key, width })
  }
  const layout = () => {
    const bounds = window.getContentBounds()
    const page = current().kind === "page"
    bar.setBounds({ x: 0, y: 0, width: page ? bounds.width : Math.min(stripWidth(), bounds.width), height: TITLE_BAR_HEIGHT })
    views.forEach((view, id) => {
      const tab = tabs.find((item) => item.id === id)!
      const top = tab.kind === "page" ? TITLE_BAR_HEIGHT : 0
      view.setBounds({ x: 0, y: top, width: bounds.width, height: Math.max(0, bounds.height - top) })
      void inset(tab, view.webContents)
    })
  }
  // Views load on first selection, so an unopened host's page never runs in the background.
  const view = (id: string, url?: string) => {
    const existing = views.get(id)
    if (existing) return existing
    const tab = tabs.find((item) => item.id === id)
    if (!tab) throw new Error(`Unknown host tab ${id}`)
    const created = new WebContentsView({ webPreferences: preferences(tab.session) })
    created.setBackgroundColor("#111113")
    tab.guard(created.webContents)
    created.webContents.on("zoom-changed", () => setTimeout(() => void inset(tab, created.webContents), 0))
    created.webContents.on("did-finish-load", () => {
      css.delete(tab.id)
      void inset(tab, created.webContents)
    })
    views.set(id, created)
    window.contentView.addChildView(created)
    // Keep the strip above every host view.
    window.contentView.addChildView(bar)
    layout()
    void created.webContents.loadURL(url ?? tab.url)
    return created
  }
  const badgeText = (id: string) => {
    // Only inactive tabs carry a badge: the shown host already displays its own queue.
    if (id === state.selected) return ""
    const badge = shownBadge(id)
    if (!badge) return ""
    if (badge === "unavailable") return " "
    if (!badge.count && !badge.partial) return ""
    return `${badge.count > 99 ? "99+" : badge.count}${badge.partial ? "+" : ""}`
  }
  // Collapsed: other hosts' counts summed; any unreadable host makes the sum unknown.
  const summary = () => {
    const others = tabs.filter((tab) => tab.id !== state.selected).map((tab) => badges.get(tab.id))
    if (others.some((badge) => badge === "unavailable")) return " "
    const total = others.reduce((sum, badge) => sum + (badge && badge !== "unavailable" ? badge.count : 0), 0)
    const partial = others.some((badge) => badge && badge !== "unavailable" && badge.partial)
    return total || partial ? `${total > 99 ? "99+" : total}${partial ? "+" : ""}` : ""
  }
  const paint = () => {
    const html = narrow()
      ? collapsedHTML(current(), current().kind === "page", summary())
      : barHTML(strip(), state.selected, current().kind === "page", badgeText, shownBadge)
    if (html === state.painted) return
    state.painted = html
    // Load on a later task, coalesced to the latest strip: a selection can run inside another
    // navigation's callbacks (e.g. "blur" while a commit swaps frames), and starting the strip's
    // navigation there crashes Chromium (null read creating the NavigationRequest).
    if (state.queued) return
    state.queued = true
    setImmediate(() => {
      state.queued = false
      if (!bar.webContents.isDestroyed()) void bar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(state.painted)}`)
    })
  }
  const select = (id: string) => {
    if (!tabs.some((item) => item.id === id)) return
    state.selected = id
    const shown = view(id)
    views.forEach((item) => item.setVisible(item === shown))
    layout()
    paint()
    shown.webContents.focus()
  }
  window.on("resize", () => {
    layout()
    paint()
  })
  return {
    select,
    selected: () => state.selected,
    // Re-applies geometry after the shown view's zoom changed.
    refresh: () => layout(),
    shownContents: () => view(state.selected).webContents,
    hosts: () => tabs.map((tab) => ({ id: tab.id, label: tab.label, badge: badges.get(tab.id) })),
    contents: (id: string) => view(id).webContents,
    /** Creates a host's view on `url` (a validated app route on its listener) instead of its start page. */
    open: (id: string, url: string) => {
      const existing = views.get(id)
      if (existing) void existing.webContents.loadURL(url)
      else view(id, url)
    },
    sessions: () => [...new Set(tabs.map((tab) => tab.session))],
    setBadge: (id: string, badge: Badge) => {
      badges.set(id, badge)
      paint()
      layout()
    },
  }
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const style = (full: boolean) => `<style>
html,body{margin:0;height:100%;background:${full ? "#0a0a0c" : "transparent"};color:#a6adc8;font:600 12px system-ui;-webkit-user-select:none;user-select:none;overflow:hidden}
nav{display:flex;align-items:center;gap:2px;height:100%;padding-left:${CONTROLS_INSET}px;padding-right:8px;-webkit-app-region:drag;box-sizing:border-box;${full ? "border-bottom:1px solid #26262b;" : ""}}
a{-webkit-app-region:no-drag;display:flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:6px;color:inherit;text-decoration:none;white-space:nowrap}
bdi{max-width:150px;overflow:hidden;text-overflow:ellipsis}
a:hover{color:#cdd6f4;background:#26262b}
a:focus-visible{outline:2px solid #b4befe;outline-offset:-2px}
a[aria-current=page]{color:#cdd6f4;background:#26262b}
b{min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#fab387;color:#040405;font-size:10px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}
b.unknown{background:transparent;border:1px dashed #6c7086;min-width:12px;width:12px;height:12px;padding:0}
</style>`

const collapsedHTML = (tab: HostTab, full: boolean, summary: string) => {
  const unknown = summary === " "
  const label = unknown ? "Other hosts: Needs you unavailable" : summary ? `Other hosts: ${summary} need you` : ""
  const mark = summary ? `<b${unknown ? ' class="unknown"' : ""} aria-label="${label}">${unknown ? "" : summary}</b>` : ""
  return `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Hosts</title>${style(full)}<nav aria-label="Hosts"><a href="${TAB_URL}${MENU}" aria-current="page" aria-haspopup="menu" title="${escape(`Host: ${tab.label}${label ? ` · ${label}` : ""}`)}"><bdi dir="auto">${escape(tab.label)}</bdi><span aria-hidden="true">▾</span>${mark}</a></nav></html>`
}

const barHTML = (tabs: HostTab[], selected: string, full: boolean, badge: (id: string) => string, shown: (id: string) => Badge | undefined) =>
  `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Hosts</title>${style(full)}<nav aria-label="Hosts">${tabs
    .map((tab) => {
      const text = badge(tab.id)
      const value = shown(tab.id)
      const label = value === "unavailable" ? "Needs you unavailable" : `${text.trim()} need${text === "1" ? "s" : ""} you`
      const mark = text ? `<b${value === "unavailable" ? ' class="unknown"' : ""} aria-label="${label}">${value === "unavailable" ? "" : text}</b>` : ""
      const tip = escape(text ? `${tab.label} · ${label}` : tab.label)
      return `<a href="${TAB_URL}${encodeURIComponent(tab.id)}" title="${tip}"${tab.id === selected ? ' aria-current="page"' : ""}><bdi dir="auto">${escape(tab.label)}</bdi>${mark}</a>`
    })
    .join("")}</nav></html>`

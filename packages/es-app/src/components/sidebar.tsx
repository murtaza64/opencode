/* Agents mode sidebar: the mode switch, the agent map, and every active session. Collapsed, it becomes
 * a mini icon rail — expand toggle up top (where the switcher lives), board
 * icon, then one status dot per session, still navigable. Archived sessions
 * drop to a collapsed section at the bottom of the expanded view. */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { A, useLocation } from "@solidjs/router"
import { es, type SessionSearchResult } from "../api"
import { sessionHref, useDashboard, type DotState, type SessionRow } from "../state"
import { leftOpen, leftWidth, toggleLeft } from "../ui"
import { nativeHeader, NativeHeader } from "./native-header"
import { NewSession } from "./new-session"
import { peekAttrs, SessionPeek } from "./session-peek"
import { CloudNav, CloudSource } from "./cloud-sidebar"
import { cloudRows } from "../cloud-rows"
import { byBoundary, dateGroup, type DateGroup } from "../turn-order"
import { compareRows } from "../session-recency"
import { cloudKey, type CloudPin } from "../cloud-agents"
import { rankSearch, type Searchable } from "../search-rank"
import { failureLabel } from "../session-failures"
import { ringOnChange } from "../motion"
import { Glyph, HostGlyph } from "./icons"
import { hostRowKey, hostSessionHref, workRows, type HostFeed } from "../host-feed"
import { host } from "../host"
import { NavEntries } from "./mode-switch"
import { TodayCost } from "./today-cost"
import { waveStart } from "../wave"
import { NavTabs, NeedsYouBand } from "./nav-tabs"

/** Project scope for browsing (the same dashboard scope New session targets): a chip in the Agents filter row
 * that opens a short list of projects. Escape or choosing closes it and returns focus to the chip. */
export const ProjectScope = (props: { onChange?: () => void }) => {
  const { state, editspace, setEditspace, editspaces, allProjects, setAllProjects } = useDashboard()
  const current = () => editspace() ?? editspaces()?.default ?? state()?.editspace ?? ""
  let menu: HTMLDetailsElement | undefined
  const pick = (name?: string) => {
    props.onChange?.()
    if (name === undefined) setAllProjects(true)
    else setEditspace(name)
    menu!.open = false
    menu!.querySelector("summary")?.focus()
  }
  return <details class="agent-filter scope-menu" ref={menu} onKeyDown={(event) => { if (event.key === "Escape" && menu!.open) { event.preventDefault(); menu!.open = false; menu!.querySelector("summary")?.focus() } }}>
    <summary aria-label={`Project: ${allProjects() ? "all projects" : current()}`} title="Project scope (also where New session starts)">
      <bdi dir="auto">{allProjects() ? "All projects" : current()}</bdi><span class="scope-caret" aria-hidden="true">▾</span>
    </summary>
    <div class="scope-list" role="group" aria-label="Project">
      <button type="button" aria-pressed={allProjects()} onClick={() => pick()}>All projects</button>
      <For each={editspaces()?.editspaces ?? []}>{(item) =>
        <button type="button" aria-pressed={!allProjects() && current() === item.name} onClick={() => pick(item.name)}><bdi dir="auto">{item.name}</bdi></button>}</For>
    </div>
  </details>
}

// Day headings come from the row's last turn boundary only (turn-order.ts); unknown is Undated, never Today.
const GROUP_LABEL: Record<DateGroup, string> = { today: "Today", yesterday: "Yesterday", week: "This week", older: "Older", undated: "Undated" }

const StatusDot = (props: { state: DotState; label?: string }) => {
  let el: HTMLElement | undefined
  ringOnChange(() => el, () => props.state)
  // Busy rows pulse their halo in CSS (index.css busy idiom); no JS clock. The shared-clock wave start is read once
  // when the row becomes busy (appearance.css busy wave).
  const start = createMemo<number | undefined>((previous) => props.state === "busy" ? previous ?? waveStart() : undefined)
  return <span ref={(node) => el = node} class={`dot ${props.state}`} style={start() === undefined ? undefined : { "--wave-start": String(start()) }}
    {...(props.state === "failed" ? { role: "img", "aria-label": props.label ?? "Failed" } : {})} />
}

export default function Sidebar() {
  const { state, dotFor, editspace, setEditspace, editspaces, archivedIds,
    allProjects, sessionRows, sessions, pinnedSessions, unpinnedSessions, isPinned, togglePin,
    sessionsLoading, sessionsError, setVisibleSessions, cloud, failures, work, stateError, pinnedUnion } =
    useDashboard()
  // Work view: this host's rows and every other Work view host's rows in one list. Other hosts' rows
  // carry their host and open on that host's own tab; a host that stops answering keeps its last
  // rows, dimmed and disabled, never emptied or merged into this host's.
  const hosted = () => work.feeds().length > 0
  // The open session's host-qualified key. The same session ID can exist on Local and on another host, so the
  // path alone cannot say which row is open; `?host=` (absent or "local": this page's Core) decides, as the
  // session page does.
  const location = useLocation()
  const openKey = createMemo(() => {
    const match = /^\/session\/([^/]+)/.exec(location.pathname)
    if (!match) return undefined
    const host = location.query.host
    return hostRowKey({ id: decodeURIComponent(match[1]), host: typeof host === "string" && host && host !== "local" ? host : undefined })
  })
  const isOpen = (s: SessionRow) => openKey() === hostRowKey(s)
  // Unified Work: this machine and every other Work host, all shown by default. Hiding a host is a per-page
  // choice stored as the hidden set, so a host added later is shown; Personal pages have no Work strip.
  const ownHost = () => host()?.work.find((item) => item.id === host()?.id) ?? { id: host()?.id ?? "local", label: "Local" }
  const workHosts = () => [{ id: ownHost().id, label: ownHost().label }, ...work.feeds().map((feed) => ({ id: feed.host.id, label: feed.host.label }))]
  const HIDDEN_KEY = "es-app:work-hidden-hosts"
  const readHidden = () => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]")
      return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
    } catch {
      return new Set<string>()
    }
  }
  const [hiddenHosts, setHiddenHosts] = createSignal(readHidden())
  // A stored choice that would hide every host (or names no current host) shows them all.
  const shownHost = (id: string) => !hiddenHosts().has(id) || workHosts().every((item) => hiddenHosts().has(item.id))
  const toggleHost = (id: string) => {
    const next = new Set(hiddenHosts())
    if (next.has(id)) next.delete(id)
    else if (workHosts().filter((item) => !next.has(item.id)).length > 1) next.add(id)
    setHiddenHosts(next)
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])) } catch { /* kept for this page */ }
  }
  const hostCount = (id: string) => id === ownHost().id ? unpinnedSessions().length + pinnedSessions().length
    : (work.feeds().find((feed) => feed.host.id === id)?.state().rows.length ?? 0)
  const allPinned = pinnedUnion
  // Agents tab controls (NAV-16): an explicit sort beside the default activity order, and an active-only filter.
  const SORT_KEY = "es-app:agents-sort"
  const ACTIVE_KEY = "es-app:agents-active-only"
  const [sortBy, setSortByRaw] = createSignal<"activity" | "name">(localStorage.getItem(SORT_KEY) === "name" ? "name" : "activity")
  const [activeOnly, setActiveOnlyRaw] = createSignal(localStorage.getItem(ACTIVE_KEY) === "on")
  const setSortBy = (value: "activity" | "name") => { setSortByRaw(value); try { localStorage.setItem(SORT_KEY, value) } catch { /* kept for this page */ } }
  const setActiveOnly = (value: boolean) => { setActiveOnlyRaw(value); try { localStorage.setItem(ACTIVE_KEY, value ? "on" : "off") } catch { /* kept for this page */ } }
  const allUnpinned = createMemo(() => workRows(unpinnedSessions(), work.unpinned()))
  // Cloud agents the view already discovers sit in the ordinary list beside sessions, newest first; pinned
  // ones stay in Pinned. Same entries, account scope and pins as before; no separate drawer.
  const cloudUnpinned = createMemo(() => cloudRows({ pins: [], observed: cloud.observed(), other: cloud.other(), snapshots: cloud.snapshots() }))
  // Default order (NAV-11, session-recency.ts compareRows): rows working on their own host above idle ones; within
  // each group, the last turn boundary newest first, unknown boundaries by title then key. Turn boundaries come from
  // Core's Session.time.turn once it exists (none yet: every row is undated); never time.updated. Parts, tools and
  // polls change none of these inputs, so a row moves only when its status or a turn boundary changes.
  const boundaryOf = (_row: { kind: "session" | "cloud" }): number | undefined => undefined
  const liveOf = (row: { kind: "session"; item: SessionRow } | { kind: "cloud"; item: ReturnType<typeof cloudRows>[number] }) =>
    row.kind === "cloud" ? row.item.status.chip === "busy" : row.item.host ? work.dot(row.item) === "busy" : dotFor(row.item) === "busy"
  // Row wrappers are reused while their item and boundary are unchanged, so streamed updates never remount a row
  // (its DOM, focus and busy-halo phase stay put); only a boundary change can move it.
  type AgentRow = ({ kind: "session"; item: SessionRow } | { kind: "cloud"; item: ReturnType<typeof cloudRows>[number] }) & { key: string; boundary?: number; live?: boolean }
  // What a row renders (activity time excluded): a session.updated that only bumps time keeps the same row.
  const sameShown = (a: AgentRow, b: AgentRow) => a.item === b.item || (a.kind === "session" && b.kind === "session"
    ? a.item.title === b.item.title && a.item.directory === b.item.directory && a.item.archived === b.item.archived && a.item.project === b.item.project && a.item.host === b.item.host
    : a.kind === "cloud" && b.kind === "cloud" && JSON.stringify({ ...a.item, changedAt: 0 }) === JSON.stringify({ ...b.item, changedAt: 0 }))
  let previousRows = new Map<string, AgentRow>()
  const agentRows = createMemo(() => {
    const next = new Map<string, AgentRow>()
    const keep = (row: AgentRow) => {
      const old = previousRows.get(row.key)
      const kept = old && old.boundary === row.boundary && old.live === row.live && sameShown(old, row) ? old : row
      next.set(row.key, kept)
      return kept
    }
    const rows = [
      ...allUnpinned().filter((item) => shownHost(item.host ?? ownHost().id)).map((item): AgentRow => ({ kind: "session", key: hostRowKey(item), item })),
      ...cloudUnpinned().map((item): AgentRow => ({ kind: "cloud", key: `wingman:${item.key}`, item })),
    ].map((row) => keep({ ...row, boundary: boundaryOf(row), live: liveOf(row) }))
      .sort((a, b) => compareRows(
        { clock: { key: a.key, recency: a.boundary, state: "unknown", live: !!a.live }, title: a.item.title },
        { clock: { key: b.key, recency: b.boundary, state: "unknown", live: !!b.live }, title: b.item.title }))
    previousRows = next
    return rows
  })
  // Shown rows: the activity order above, or by name (stable ties by key); active-only keeps the live bucket.
  const shownRows = createMemo(() => {
    const rows = activeOnly() ? agentRows().filter((row) => row.live) : agentRows()
    return sortBy() === "name" ? [...rows].sort((a, b) => (a.item.title || "").localeCompare(b.item.title || "") || a.key.localeCompare(b.key)) : rows
  })
  const cloudPin = (row: { project: string; title: string; owner: string }) => cloud.other().find((item) => item.editspace === row.project && item.lane === row.title && item.owner === row.owner)
  const feedOf = (s: SessionRow) => work.feeds().find((feed) => feed.host.id === s.host)
  const localUnavailable = () => hosted() && !!(allProjects() ? sessionsError() : stateError())
  // The Agents tab count: agents working now in this browse scope (shown hosts, this project), pinned included,
  // from the same live bucket the order uses. A host or list that cannot be read makes it "N+", never a false 0.
  const activeCount = createMemo(() => {
    const pinnedLive = allPinned().filter((s) => shownHost(s.host ?? ownHost().id)).filter((s) => s.host ? work.dot(s) === "busy" : dotFor(s) === "busy").length
    const count = agentRows().filter((row) => row.live).length + pinnedLive
    const behind = [...(localUnavailable() ? [ownHost().label] : []),
      ...work.feeds().filter((feed) => shownHost(feed.host.id) && feed.state().status !== "ready").map((feed) => feed.host.label)]
    return { text: behind.length ? `${count}+` : count ? String(count) : "",
      title: `${count} working now${behind.length ? `; ${behind.join(", ")} not current` : ""}` }
  })
  const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const dotText = (s: SessionRow, dot: DotState) => {
    const failure = dot === "failed" ? failures.failure(s.id) : undefined
    return failure ? `failed: ${failureLabel(failure)}` : dot
  }
  const observed = new Map<Element, string>()
  const visible = new Set<Element>()
  let published = new Set<string>()
  // IntersectionObserver fires on every layout shift; republish only when the
  // visible set changes, since each new Set re-derives activity directories.
  const publishVisible = () => {
    const next = new Set(document.visibilityState === "visible"
      ? [...visible].map((el) => observed.get(el)!).filter(Boolean) : [])
    if (next.size === published.size && [...next].every((id) => published.has(id))) return
    published = next
    setVisibleSessions(next)
  }
  document.addEventListener("visibilitychange", publishVisible)
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio > 0) visible.add(entry.target)
      else visible.delete(entry.target)
    }
    publishVisible()
  })
  const observeSession = (el: HTMLElement, id: string) => {
    observed.set(el, id)
    observer.observe(el)
    onCleanup(() => {
      observer.unobserve(el)
      observed.delete(el)
      visible.delete(el)
      publishVisible()
    })
  }
  onCleanup(() => {
    observer.disconnect()
    document.removeEventListener("visibilitychange", publishVisible)
    setVisibleSessions(new Set())
  })
  const archived = () => sessionRows().filter((s) => archivedIds().has(s.id)).sort((a, b) => b.updated - a.updated)
  const [showArchived, setShowArchived] = createSignal(false)
  // hover/focus insight card delegates from whichever nav is mounted
  const [navEl, setNavEl] = createSignal<HTMLElement>()
  const current = () => editspace() ?? editspaces()?.default ?? state()?.editspace ?? ""

  // Titles filter immediately; transcript search starts at three characters.
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SessionSearchResult[] | null>(null)
  // Transcript hits from the server, kept to this view's scope.
  const transcriptHits = () => {
    const root = editspaces()?.editspaces.find((s) => s.name === current())?.root.replace(/\/\.editspace\/?$/, "")
    const rows = sessionRows()
    const directories = new Set(rows.map((s) => s.directory))
    return (results() ?? []).filter((s) =>
      (!allProjects() || !s.parent_id) && (allProjects() || directories.has(s.directory) ||
        (s.parent_id !== null && rows.some((row) => row.id === s.parent_id)) ||
        (root !== undefined && (s.directory === root || s.directory.startsWith(`${root}/`)))))
  }
  // One ranking (search-rank.ts): pins stay in Pinned for any query; title/lane matches from every row this page
  // knows (this host, other Work hosts, cloud) come before transcript-only hits, also when those arrive late.
  // Within a bucket: working first, then most recent. Rows keep their host- or runtime-qualified key.
  type Found = Searchable & { updated: number; working: boolean } & ({ local: SessionSearchResult; host?: undefined; cloud?: undefined } | { host: SessionRow; local?: undefined; cloud?: undefined } | { cloud: CloudPin; local?: undefined; host?: undefined })
  const localFound = (r: SessionSearchResult): Found => {
    const row = sessionRows().find((s) => s.id === r.id && s.directory === r.directory)
    return { key: `local:${r.directory}:${r.id}`, title: r.title || r.id, updated: r.updated ?? 0, working: !!row && dotFor(row) === "busy", local: r }
  }
  const asResult = (s: SessionRow): SessionSearchResult => ({ id: s.id, title: s.title, directory: s.directory, parent_id: null, updated: s.updated, snippet: "", matches: 0 })
  const hostFound = (s: SessionRow): Found => ({ key: hostRowKey(s), title: s.title || s.id, updated: s.updated, working: work.dot(s) === "busy", host: s })
  const cloudFound = (pin: CloudPin): Found => ({ key: `cloud:${cloudKey(pin)}`, title: pin.lane, lane: pin.lane, updated: 0, working: false, cloud: pin })
  const ranked = createMemo(() => rankSearch<Found>({
    query: query(),
    pinned: [...allPinned().map((s) => s.host ? hostFound(s) : localFound(asResult(s))), ...cloud.pins().map(cloudFound)],
    known: [...sessionRows().map((s) => localFound(asResult(s))), ...work.unpinned().map(hostFound), ...cloud.other().map(cloudFound)],
    transcriptHits: transcriptHits().map(localFound),
    // Within a bucket: the same turn-boundary order as the list (unknown: stable by key).
    order: (a, b) => byBoundary({ key: a.key }, { key: b.key }),
  }))
  const foundRows = createMemo(() => [...ranked().metadata, ...ranked().transcript])
  const [searching, setSearching] = createSignal(false)
  const [allTime, setAllTime] = createSignal(false)
  const [searchError, setSearchError] = createSignal("")
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchSeq = 0

  const runSearch = async (q: string, days: number) => {
    const seq = ++searchSeq
    setSearching(true)
    setSearchError("")
    try {
      const r = await es.search(q, days)
      if (seq !== searchSeq) return
      setResults(r.results ?? [])
    } catch {
      if (seq !== searchSeq) return
      setResults([])
      setSearchError("transcript search unavailable; showing matching titles")
    } finally {
      if (seq === searchSeq) setSearching(false)
    }
  }

  const onQuery = (v: string) => {
    setQuery(v)
    setAllTime(false)
    clearTimeout(searchTimer)
    searchSeq++ // invalidate in-flight responses
    setResults(null)
    setSearchError("")
    if (v.trim().length < 3) {
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimer = setTimeout(() => runSearch(v.trim(), 30), 350)
  }

  const searchAllTime = () => {
    setAllTime(true)
    runSearch(query().trim(), 0)
  }

  const clearSearch = () => onQuery("")

  const resultItem = (r: SessionSearchResult) => (
    <A href={sessionHref(r.id, r.directory)} class="nav-item search-result" title={r.directory}>
      <span class="search-result-body">
        <span class="nav-title" dir="auto">{r.title || r.id}</span>
        <Show when={r.snippet}>
          <span class="search-snippet">{r.snippet}</span>
        </Show>
        <span class="search-meta">{allProjects()
          ? sessionRows().find((s) => s.id === r.id)?.project || r.directory.split("/").filter(Boolean).at(-1)
          : r.directory.split("/").slice(-2).join("/")}</span>
      </span>
    </A>
  )

  // dotFor reads every activity snapshot; memoize per row so unrelated status
  // and request updates do not rewrite each row's class and title (~100
  // same-value class writes/s across a long sidebar).
  const item = (s: SessionRow, cls = "") => {
    if (s.host) return hostItem(s)
    const dot = createMemo(() => dotFor(s))
    return cls === "archived" ? (
    <a
      href={sessionHref(s.id, s.directory)}
      class="nav-item archived"
      classList={{ active: isOpen(s) }}
      aria-current={isOpen(s) ? "page" : undefined}
      {...peekAttrs(s)}
    >
      <StatusDot state={dot()} label={dotText(s, dot())} />
      <span class="nav-title" dir="auto">{s.title || s.id}</span>
      {/* All scope: the project lives in the hover/focus card; screen readers still hear it here. */}
      <Show when={allProjects() && s.project}><span class="sr-only">, {s.project}</span></Show>
    </a>
  ) : (
    <div class="session-entry" {...peekAttrs(s)}>
      <a
        ref={(el) => observeSession(el, s.id)}
        href={sessionHref(s.id, s.directory)}
        class="nav-item"
        classList={{ active: isOpen(s) }}
        aria-current={isOpen(s) ? "page" : undefined}
      >
        <StatusDot state={dot()} label={dotText(s, dot())} />
        <Show when={hosted()}><HostGlyph host="local" /></Show>
        <span class="nav-title" dir="auto">{s.title || s.id}</span>
        <Show when={allProjects() && s.project}><span class="sr-only">, {s.project}</span></Show>
        <Show when={hosted()}><span class="sr-only">, on Local</span></Show>
      </a>
      <button type="button" class="pin-action" classList={{ pinned: isPinned(s) }}
        aria-label={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        title={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        onClick={() => togglePin(s)}>{isPinned(s) ? "\u2665\ufe0e" : "\u2661\ufe0e"}</button>
    </div>
  )
  }

  // Another host's session: opens on that host's tab (its own origin, auth, drafts and receipts).
  const hostItem = (s: SessionRow) => {
    const feed = feedOf(s)
    const label = () => feed?.host.label ?? s.host!
    const down = () => feed?.state().status === "unavailable"
    const dot = createMemo(() => work.dot(s))
    const name = () => `${s.title || s.id}, on ${label()}${down() ? ", unavailable" : ""}`
    return (
    <div class="session-entry host-entry" classList={{ unavailable: down() }}>
      <a href={feed ? hostSessionHref(feed.host, s) : undefined} class="nav-item" classList={{ active: isOpen(s) }}
        aria-current={isOpen(s) ? "page" : undefined} aria-label={name()} aria-disabled={down() || undefined}
        title={down() ? `${label()} · unreachable since ${clock(feed?.state().since ?? Date.now())}; last-known list, actions disabled` : `${s.title || s.id} — on ${label()}`}
        data-host-key={hostRowKey(s)} onClick={(event) => { if (down()) event.preventDefault() }}>
        <StatusDot state={dot()} label={`${label()}: ${dot()}`} />
        <HostGlyph host={s.host!} />
        <span class="nav-title" dir="auto">{s.title || s.id}</span>
      </a>
      <button type="button" class="pin-action" classList={{ pinned: work.isPinned(s) }}
        aria-label={`${work.isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id} on ${label()}`}
        title={`${work.isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        onClick={() => work.togglePin(s)}>{work.isPinned(s) ? "\u2665\ufe0e" : "\u2661\ufe0e"}</button>
    </div>
  )
  }
  // A host's availability, shown only when it differs from "listed": loading, unreachable, or nothing here.
  const hostStatus = (feed: HostFeed) => {
    const state = feed.state
    return <Show when={state().status !== "ready" || !state().rows.length}>
      <div class="dim nav-empty host-status" classList={{ unavailable: state().status === "unavailable" }} role="status">
        <HostGlyph host={feed.host.id} />
        <span>{feed.host.label} · {state().status === "loading" ? "loading…"
          : state().status === "unavailable" ? `unreachable since ${clock(state().since ?? Date.now())}`
          : allProjects() ? "no sessions" : `no ${current()} sessions`}</span>
        <Show when={state().status === "unavailable"}><button type="button" class="link-button" onClick={() => void feed.load()}>Retry</button></Show>
      </div>
    </Show>
  }

  const miniItem = (s: SessionRow) => {
    if (s.host) {
      const feed = feedOf(s)
      return <div class="mini-session" classList={{ unavailable: feed?.state().status === "unavailable" }}>
        <a href={feed ? hostSessionHref(feed.host, s) : undefined} class="mini-item" classList={{ active: isOpen(s) }}
          aria-current={isOpen(s) ? "page" : undefined} title={`${s.title} — on ${feed?.host.label ?? s.host}`}
          aria-label={`${s.title || s.id}, on ${feed?.host.label ?? s.host}`}>
          <StatusDot state={work.dot(s)} />
        </a>
      </div>
    }
    const dot = createMemo(() => dotFor(s))
    return (
    <div class="mini-session" {...peekAttrs(s)}>
      <a ref={(el) => observeSession(el, s.id)} href={sessionHref(s.id, s.directory)}
        class="mini-item" classList={{ active: isOpen(s) }} aria-current={isOpen(s) ? "page" : undefined}
        title={`${s.title} (${dotText(s, dot())})${allProjects() ? ` · ${s.project}` : ""}`}>
        <StatusDot state={dot()} label={`${s.title || s.id}: ${dotText(s, dot())}`} />
      </a>
      <button type="button" class="mini-pin" classList={{ pinned: isPinned(s) }}
        aria-label={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        title={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        onClick={() => togglePin(s)}>{isPinned(s) ? "\u2665\ufe0e" : "\u2661\ufe0e"}</button>
    </div>
  )
  }

  const projectControls = () => <>
    <button class="mini-btn" title={leftOpen() ? "collapse sidebar (^h)" : "expand sidebar (^h)"}
      aria-label={leftOpen() ? "Collapse sidebar" : "Expand sidebar"} onClick={toggleLeft}>
      {leftOpen() ? "⟨" : "⟩"}
    </button>
  </>

  return (<>
    <Show when={nativeHeader}><NativeHeader>{projectControls()}</NativeHeader></Show>
    <Show
      when={leftOpen()}
      fallback={
        <nav class="sidebar sidebar-mini" ref={setNavEl}>
          <Show when={!nativeHeader}><button class="mini-btn" title="expand sidebar (^h)" onClick={toggleLeft}>
            ⟩
          </button></Show>
          <NavEntries compact />
          <NewSession compact />
          <Show when={allPinned().length || cloud.pins().length}>
            <div class="mini-pinned-heading" title="Pinned sessions" aria-label="Pinned sessions" />
            <For each={allPinned()}>{miniItem}</For>
            <For each={cloud.pins()}>{pin => <CloudNav pin={pin} mini />}</For>
          </Show>
          <For each={allUnpinned()}>{miniItem}</For>
        </nav>
      }
    >
      <nav class="sidebar" ref={setNavEl} style={{ width: `${leftWidth()}px` }}>
        <Show when={!nativeHeader}><div class="sidebar-top">{projectControls()}<TodayCost /></div></Show>
        {/* Unified nav (dotfiles#240): primary entries, then what needs you (never filtered by a tab), then
          * Pinned (any kind), then four browse tabs with their own filters. */}
        <NavEntries />
        <nav class="sidebar-actions" aria-label="Agents">
          <NewSession />
        </nav>
        {/* Explicit requests only (attention records, permissions, questions, delivered requests). A finished or idle
          * agent is activity: its row's status dot and order in Agents show it, never a Needs you row. */}
        <NeedsYouBand />
        <Show when={allPinned().length || cloud.pins().length}>
          <section class="pinned-section" aria-label="Pinned sessions">
            <div class="nav-heading">Pinned</div>
            <For each={allPinned()}>{(s) => item(s)}</For>
            <For each={cloud.pins()}>{pin => <CloudNav pin={pin} />}</For>
          </section>
        </Show>
        <NavTabs agentsCount={activeCount()} agents={<>
          <div class="agent-filters" role="group" aria-label="Agents view">
            <ProjectScope onChange={clearSearch} />
            <button type="button" class="agent-filter" aria-pressed={activeOnly()} title="Show only agents working now" onClick={() => setActiveOnly(!activeOnly())}>Active</button>
            <button type="button" class="agent-filter agent-sort" title={sortBy() === "activity" ? "Sorted by activity: working first, then latest turn. Click for name." : "Sorted by name. Click for activity."}
              aria-label={`Sort: ${sortBy() === "activity" ? "activity" : "name"}`} onClick={() => setSortBy(sortBy() === "activity" ? "name" : "activity")}>
              <span aria-hidden="true">⇅</span> {sortBy() === "activity" ? "Activity" : "Name"}
            </button>
          </div>
          <Show when={hosted() && host()?.profile !== "personal"}>
            <div class="work-hosts" role="group" aria-label="Work hosts">
              <span class="work-hosts-label">Work</span>
              <For each={workHosts()}>{(item) =>
                <button type="button" class="work-host" aria-pressed={shownHost(item.id)} title={shownHost(item.id) ? `Hide ${item.label} sessions` : `Show ${item.label} sessions`}
                  onClick={() => toggleHost(item.id)}>
                  <HostGlyph host={item.id} /><span>{item.label}</span><span class="work-host-count">{hostCount(item.id) || ""}</span>
                </button>}</For>
            </div>
          </Show>
        <div class="search-box">
          <input
            class="search-input"
            type="search"
            placeholder="search sessions…"
            value={query()}
            onInput={(e) => onQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Escape" && clearSearch()}
          />
        </div>
        <Show
          when={!query().trim()}
          fallback={
            <>
              <div class="nav-heading">
                results ({foundRows().length})
              </div>
              <Show when={searching()}><div class="dim nav-empty">searching transcripts…</div></Show>
              <Show when={searchError()}>
                <div class="dim nav-empty">{searchError()}</div>
              </Show>
              <Show when={!searching() && !searchError() && !foundRows().length}>
                <div class="dim nav-empty">no matches</div>
              </Show>
              <For each={foundRows()}>{(found) => found.host ? hostItem(found.host) : found.cloud ? <CloudNav pin={found.cloud} /> : resultItem(found.local)}</For>
              <Show when={query().trim().length >= 3 && !allTime() && !searching() && !searchError()}>
                <button class="archived-toggle" onClick={searchAllTime}>
                  ⌕ all time (slow)
                </button>
              </Show>
            </>
          }
        >
          {/* Cached rows stay; load trouble is the header's shared status, not a list banner. */}
          <Show when={hosted()}>
            <Show when={localUnavailable() || (!unpinnedSessions().length && !pinnedSessions().length && !sessionsLoading())}>
              <div class="dim nav-empty host-status" classList={{ unavailable: localUnavailable() }} role="status"><HostGlyph host="local" />
                <span>Local · {localUnavailable() ? "unavailable — retrying" : allProjects() ? "no sessions" : `no ${current()} sessions`}</span></div>
            </Show>
            <For each={work.feeds()}>{hostStatus}</For>
          </Show>
          <CloudSource />
          <Show when={shownRows().length} fallback={
            <Show when={!hosted() || activeOnly()}><div class="dim nav-empty">{activeOnly() ? "No agents working now" : sessionsError() ? "Sessions unavailable — retrying" : sessionsLoading() ? "loading..." : pinnedSessions().length ? "All active sessions pinned" : "none"}</div></Show>
          }>
            <For each={shownRows()}>
              {(row, index) => {
                const group = () => dateGroup(row.boundary, Date.now())
                const before = () => index() > 0 ? shownRows()[index() - 1] : undefined
                // A heading marks each change of group; a list that is all undated needs none.
                const heading = () => sortBy() !== "activity" ? false : index() === 0 ? group() !== "undated" : group() !== dateGroup(before()!.boundary, Date.now())
                return (
                  <>
                    <Show when={heading()}>
                      <div class="nav-heading nav-day">{GROUP_LABEL[group()]}</div>
                    </Show>
                    {row.kind === "session" ? item(row.item) : <Show when={cloudPin(row.item)}>{(pin) => <CloudNav pin={pin()} />}</Show>}
                  </>
                )
              }}
            </For>
          </Show>
          <Show when={archived().length}>
            <button class="archived-toggle" onClick={() => setShowArchived(!showArchived())}>
              {showArchived() ? "▾" : "▸"} archived ({archived().length})
            </button>
            <Show when={showArchived()}>
              <For each={archived()}>{(s: any) => item(s, "archived")}</For>
            </Show>
          </Show>
        </Show>
        </>} />
      </nav>
    </Show>
    <SessionPeek container={navEl} />
    </>
  )
}

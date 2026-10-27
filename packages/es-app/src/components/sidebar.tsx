/* Agents mode sidebar: the mode switch, the agent map, and every active session. Collapsed, it becomes
 * a mini icon rail — expand toggle up top (where the switcher lives), board
 * icon, then one status dot per session, still navigable. Archived sessions
 * drop to a collapsed section at the bottom of the expanded view. */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { A } from "@solidjs/router"
import { es, type SessionSearchResult } from "../api"
import { sessionHref, useDashboard, type DotState, type SessionRow } from "../state"
import { usePulse } from "../pulse"
import { leftOpen, leftWidth, toggleLeft } from "../ui"
import { nativeHeader, NativeHeader } from "./native-header"
import { NewSession } from "./new-session"
import { peekAttrs, SessionPeek } from "./session-peek"
import { CloudNav, CloudDiscovery } from "./cloud-sidebar"
import { failureLabel } from "../session-failures"
import { ringOnChange } from "../motion"
import { Glyph, HostGlyph } from "./icons"
import { hostRowKey, hostSessionHref, workRows, type HostFeed } from "../host-feed"
import { ModeSwitch } from "./mode-switch"

/** Project scope, shared by both modes' sidebars. */
export const ProjectSelect = (props: { onChange?: () => void }) => {
  const { state, editspace, setEditspace, editspaces, allProjects, setAllProjects } = useDashboard()
  const current = () => editspace() ?? editspaces()?.default ?? state()?.editspace ?? ""
  return <select class="es-switcher" aria-label="Project"
    ref={(select) => createEffect(() => {
      editspaces()
      select.value = allProjects() ? "__all__" : current()
    })}
    onChange={(e) => {
      props.onChange?.()
      if (e.currentTarget.value === "__all__") setAllProjects(true)
      else setEditspace(e.currentTarget.value)
    }}>
    <option value="__all__">All</option>
    <For each={editspaces()?.editspaces ?? []}>{(item) => <option value={item.name}>{item.name}</option>}</For>
  </select>
}

// Day separators: a quiet local-format label; rows without a usable time group as Undated.
const dayKey = (time: number) => Number.isFinite(time) && time > 0 ? new Date(time).toDateString() : "undated"
const dayLabel = (time: number) => {
  if (dayKey(time) === "undated") return "Undated"
  const date = new Date(time)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).toDateString()) return "Yesterday"
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) }).format(date)
}

const BusyDot = (props: { ref: (el: HTMLElement) => void }) => {
  const [visible, setVisible] = createSignal(false)
  const [foreground, setForeground] = createSignal(document.visibilityState === "visible")
  const visibility = () => setForeground(document.visibilityState === "visible")
  document.addEventListener("visibilitychange", visibility)
  const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)))
  const enabled = () => visible() && foreground()
  const tick = usePulse(enabled)
  onCleanup(() => {
    observer.disconnect()
    document.removeEventListener("visibilitychange", visibility)
  })
  return <span ref={(el) => { observer.observe(el); props.ref(el) }} class="dot busy"
    data-on={enabled() ? String(!!(tick() % 2)) : undefined} />
}

const StatusDot = (props: { state: DotState; label?: string }) => {
  let el: HTMLElement | undefined
  ringOnChange(() => el, () => props.state)
  return <Show when={props.state === "busy"} fallback={<span ref={(node) => el = node} class={`dot ${props.state}`}
    {...(props.state === "failed" ? { role: "img", "aria-label": props.label ?? "Failed" } : {})} />}>
    <BusyDot ref={(node) => el = node} />
  </Show>
}

export default function Sidebar() {
  const { state, dotFor, editspace, setEditspace, editspaces, archivedIds, notifications, markViewed,
    allProjects, sessionRows, sessions, pinnedSessions, unpinnedSessions, isPinned, togglePin,
    sessionsLoading, sessionsError, setVisibleSessions, cloud, failures, work, stateError } =
    useDashboard()
  // Work view: this host's rows and every other Work view host's rows in one list. Other hosts' rows
  // carry their host and open on that host's own tab; a host that stops answering keeps its last
  // rows, dimmed and disabled, never emptied or merged into this host's.
  const hosted = () => work.feeds().length > 0
  const allPinned = createMemo(() => [...pinnedSessions(), ...work.pinned()])
  const allUnpinned = createMemo(() => workRows(unpinnedSessions(), work.unpinned()))
  const feedOf = (s: SessionRow) => work.feeds().find((feed) => feed.host.id === s.host)
  const localUnavailable = () => hosted() && !!(allProjects() ? sessionsError() : stateError())
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
  const openNotification = (item: ReturnType<typeof notifications>[number]) => {
    if (item.editspace && !allProjects()) setEditspace(item.editspace)
    markViewed(item.session, true)
  }

  // Titles filter immediately; transcript search starts at three characters.
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SessionSearchResult[] | null>(null)
  const searchResults = () => {
    const titleMatches = sessionRows().filter((s) => s.title.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()))
      .map((s) => ({ id: s.id, title: s.title, directory: s.directory, parent_id: null,
        updated: s.updated, snippet: "", matches: 0 }))
    const root = editspaces()?.editspaces.find((s) => s.name === current())?.root.replace(/\/\.editspace\/?$/, "")
    const rows = sessionRows()
    const directories = new Set(rows.map((s) => s.directory))
    const remote = (results() ?? []).filter((s) =>
      (!allProjects() || !s.parent_id) && (allProjects() || directories.has(s.directory) ||
        (s.parent_id !== null && rows.some((row) => row.id === s.parent_id)) ||
        (root !== undefined && (s.directory === root || s.directory.startsWith(`${root}/`)))))
    const byID = new Map<string, SessionSearchResult>(titleMatches.map((s) => [JSON.stringify([s.directory, s.id]), s]))
    remote.forEach((s) => byID.set(JSON.stringify([s.directory, s.id]), s))
    return [...byID.values()]
  }
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
    <A
      href={sessionHref(s.id, s.directory)}
      activeClass="active"
      class="nav-item archived"
      {...peekAttrs(s)}
    >
      <StatusDot state={dot()} label={dotText(s, dot())} />
      <span class="nav-title" dir="auto">{s.title || s.id}</span>
      {/* All scope: the project lives in the hover/focus card; screen readers still hear it here. */}
      <Show when={allProjects() && s.project}><span class="sr-only">, {s.project}</span></Show>
    </A>
  ) : (
    <div class="session-entry" {...peekAttrs(s)}>
      <A
        ref={(el) => observeSession(el, s.id)}
        href={sessionHref(s.id, s.directory)}
        activeClass="active"
        class="nav-item"
      >
        <StatusDot state={dot()} label={dotText(s, dot())} />
        <Show when={hosted()}><HostGlyph host="local" /></Show>
        <span class="nav-title" dir="auto">{s.title || s.id}</span>
        <Show when={allProjects() && s.project}><span class="sr-only">, {s.project}</span></Show>
        <Show when={hosted()}><span class="sr-only">, on Local</span></Show>
      </A>
      <button type="button" class="pin-action" classList={{ pinned: isPinned(s) }}
        aria-label={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        title={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        onClick={() => togglePin(s)}>{isPinned(s) ? "◆" : "◇"}</button>
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
      <a href={feed ? hostSessionHref(feed.host, s) : undefined} class="nav-item" aria-label={name()} aria-disabled={down() || undefined}
        title={down() ? `${label()} · unreachable since ${clock(feed?.state().since ?? Date.now())}; last-known list, actions disabled` : `${s.title || s.id} — on ${label()}`}
        data-host-key={hostRowKey(s)} onClick={(event) => { if (down()) event.preventDefault() }}>
        <StatusDot state={dot()} label={`${label()}: ${dot()}`} />
        <HostGlyph host={s.host!} />
        <span class="nav-title" dir="auto">{s.title || s.id}</span>
      </a>
      <button type="button" class="pin-action" classList={{ pinned: work.isPinned(s) }}
        aria-label={`${work.isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id} on ${label()}`}
        title={`${work.isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        onClick={() => work.togglePin(s)}>{work.isPinned(s) ? "◆" : "◇"}</button>
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
        <a href={feed ? hostSessionHref(feed.host, s) : undefined} class="mini-item" title={`${s.title} — on ${feed?.host.label ?? s.host}`}
          aria-label={`${s.title || s.id}, on ${feed?.host.label ?? s.host}`}>
          <StatusDot state={work.dot(s)} />
        </a>
      </div>
    }
    const dot = createMemo(() => dotFor(s))
    return (
    <div class="mini-session" {...peekAttrs(s)}>
      <A ref={(el) => observeSession(el, s.id)} href={sessionHref(s.id, s.directory)}
        activeClass="active" class="mini-item"
        title={`${s.title} (${dotText(s, dot())})${allProjects() ? ` · ${s.project}` : ""}`}>
        <StatusDot state={dot()} label={`${s.title || s.id}: ${dotText(s, dot())}`} />
      </A>
      <button type="button" class="mini-pin" classList={{ pinned: isPinned(s) }}
        aria-label={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        title={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        onClick={() => togglePin(s)}>{isPinned(s) ? "◆" : "◇"}</button>
    </div>
  )
  }

  const projectControls = () => <>
    <ProjectSelect onChange={clearSearch} />
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
          <ModeSwitch compact />
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
        <Show when={!nativeHeader}><div class="sidebar-top">{projectControls()}</div></Show>
        <ModeSwitch />
        {/* The map is Agents mode's default page; sessions open beneath it. */}
        <nav class="sidebar-actions" aria-label="Agents">
          <A href="/agents" end activeClass="active" class="nav-item board-link">
            <Glyph name="graph" />Agent map
          </A>
          <NewSession />
        </nav>
        <Show when={!query().trim() && (allPinned().length || cloud.pins().length)}>
          <section class="pinned-section" aria-label="Pinned sessions">
            <div class="nav-heading">Pinned</div>
            <For each={allPinned()}>{(s) => item(s)}</For>
            <For each={cloud.pins()}>{pin => <CloudNav pin={pin} />}</For>
          </section>
        </Show>
        <CloudDiscovery />
        <Show when={notifications().length}>
          <div class="notification-section">
            <div class="nav-heading">needs you</div>
            <For each={notifications()}>
              {(notification) => {
                const dot = createMemo(() => dotFor({
                  id: notification.session,
                  updated: notification.updated,
                  pending: notification.kind !== "idle",
                }))
                return (
                <A
                  href={sessionHref(notification.session, notification.directory)}
                  class="nav-item notification-item"
                  title={`${notification.kind} · ${notification.editspace}`}
                  onClick={() => openNotification(notification)}
                >
                  <StatusDot state={dot()} />
                  <span class="notification-copy">
                    <span class="nav-title" dir="auto">{notification.title}</span>
                    <span class="notification-meta">
                      {notification.editspace ? `${notification.editspace} · ` : ""}{notification.kind}
                    </span>
                  </span>
                </A>
                )
              }}
            </For>
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
                results ({searchResults().length})
              </div>
              <Show when={searching()}><div class="dim nav-empty">searching transcripts…</div></Show>
              <Show when={searchError()}>
                <div class="dim nav-empty">{searchError()}</div>
              </Show>
              <Show when={!searching() && !searchError() && !searchResults().length}>
                <div class="dim nav-empty">no matches</div>
              </Show>
              <For each={searchResults()}>{resultItem}</For>
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
          <Show when={allUnpinned().length} fallback={
            <Show when={!hosted()}><div class="dim nav-empty">{sessionsError() ? "Sessions unavailable — retrying" : sessionsLoading() ? "loading..." : pinnedSessions().length ? "All active sessions pinned" : "none"}</div></Show>
          }>
            <For each={allUnpinned()}>
              {(s, index) => {
                const day = () => dayKey(s.updated)
                return (
                  <>
                    <Show when={index() === 0 || day() !== dayKey(allUnpinned()[index() - 1].updated)}>
                      <div class="nav-heading nav-day">{dayLabel(s.updated)}</div>
                    </Show>
                    {item(s)}
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
      </nav>
    </Show>
    <SessionPeek container={navEl} />
    </>
  )
}

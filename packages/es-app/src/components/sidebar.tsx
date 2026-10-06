/* Left nav: the project board plus every active session. Collapsed, it becomes
 * a mini icon rail — expand toggle up top (where the switcher lives), board
 * icon, then one status dot per session, still navigable. Archived sessions
 * drop to a collapsed section at the bottom of the expanded view. */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { A } from "@solidjs/router"
import { es, type SessionSearchResult } from "../api"
import { sessionHref, useDashboard, type SessionRow } from "../state"
import { leftOpen, leftWidth, toggleLeft } from "../ui"
import { nativeHeader, NativeHeader } from "./native-header"
import { NewSession } from "./new-session"
import { peekAttrs, SessionPeek } from "./session-peek"

export default function Sidebar() {
  const { state, dotFor, editspace, setEditspace, editspaces, archivedIds, notifications, markViewed,
    allProjects, setAllProjects, sessionRows, sessions, pinnedSessions, unpinnedSessions, isPinned, togglePin,
    sessionsLoading, sessionsError, setVisibleSessions } =
    useDashboard()
  const observed = new Map<Element, string>()
  const visible = new Set<Element>()
  const publishVisible = () => setVisibleSessions(new Set(document.visibilityState === "visible"
    ? [...visible].map((el) => observed.get(el)!).filter(Boolean) : []))
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
        <span class="nav-title">{r.title || r.id}</span>
        <Show when={r.snippet}>
          <span class="search-snippet">{r.snippet}</span>
        </Show>
        <span class="search-meta">{allProjects()
          ? sessionRows().find((s) => s.id === r.id)?.project || r.directory.split("/").filter(Boolean).at(-1)
          : r.directory.split("/").slice(-2).join("/")}</span>
      </span>
    </A>
  )

  const item = (s: SessionRow, cls = "") => cls === "archived" ? (
    <A
      href={sessionHref(s.id, s.directory)}
      activeClass="active"
      class="nav-item archived"
      title={`${s.title} (${dotFor(s)})${allProjects() ? ` · ${s.directory}` : ""}`}
      {...peekAttrs(s)}
    >
      <span class={`dot ${dotFor(s)}`} />
      <span class="nav-title">{s.title || s.id}</span>
      <Show when={allProjects()}><span class="session-project">{s.project}</span></Show>
    </A>
  ) : (
    <div class="session-entry" {...peekAttrs(s)}>
      <A
        ref={(el) => observeSession(el, s.id)}
        href={sessionHref(s.id, s.directory)}
        activeClass="active"
        class="nav-item"
        title={`${s.title} (${dotFor(s)})${allProjects() ? ` · ${s.directory}` : ""}`}
      >
        <span class={`dot ${dotFor(s)}`} />
        <span class="nav-title">{s.title || s.id}</span>
        <Show when={allProjects()}><span class="session-project">{s.project}</span></Show>
      </A>
      <button type="button" class="pin-action" classList={{ pinned: isPinned(s) }}
        aria-label={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        title={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        onClick={() => togglePin(s)}>{isPinned(s) ? "◆" : "◇"}</button>
    </div>
  )

  const miniItem = (s: SessionRow) => (
    <div class="mini-session" {...peekAttrs(s)}>
      <A ref={(el) => observeSession(el, s.id)} href={sessionHref(s.id, s.directory)}
        activeClass="active" class="mini-item"
        title={`${s.title} (${dotFor(s)})${allProjects() ? ` · ${s.project}` : ""}`}>
        <span class={`dot ${dotFor(s)}`} />
      </A>
      <button type="button" class="mini-pin" classList={{ pinned: isPinned(s) }}
        aria-label={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        title={`${isPinned(s) ? "Unpin" : "Pin"} ${s.title || s.id}`}
        onClick={() => togglePin(s)}>{isPinned(s) ? "◆" : "◇"}</button>
    </div>
  )

  const projectControls = () => <>
    <select class="es-switcher" title="project" aria-label="Project"
      ref={(select) => createEffect(() => {
        editspaces()
        select.value = allProjects() ? "__all__" : current()
      })}
      onChange={(e) => {
        clearSearch()
        if (e.currentTarget.value === "__all__") setAllProjects(true)
        else setEditspace(e.currentTarget.value)
      }}>
      <option value="__all__">All</option>
      <For each={editspaces()?.editspaces ?? []}>{(item) => <option value={item.name}>{item.name}</option>}</For>
    </select>
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
          <Show when={!allProjects()}>
            <A href="/" end activeClass="active" class="mini-item" title={`board — ${current()}`}>
              ▦
            </A>
          </Show>
          <NewSession compact />
          <Show when={pinnedSessions().length}>
            <div class="mini-pinned-heading" title="Pinned sessions" aria-label="Pinned sessions" />
            <For each={pinnedSessions()}>{miniItem}</For>
          </Show>
          <For each={unpinnedSessions()}>{miniItem}</For>
        </nav>
      }
    >
      <nav class="sidebar" ref={setNavEl} style={{ width: `${leftWidth()}px` }}>
        <Show when={!nativeHeader}><div class="sidebar-top">{projectControls()}</div></Show>
        <Show when={!query().trim() && pinnedSessions().length}>
          <section class="pinned-section" aria-label="Pinned sessions">
            <div class="nav-heading">Pinned</div>
            <For each={pinnedSessions()}>{(s) => item(s)}</For>
          </section>
        </Show>
        <Show when={notifications().length}>
          <div class="notification-section">
            <div class="nav-heading">needs you</div>
            <For each={notifications()}>
              {(notification) => (
                <A
                  href={sessionHref(notification.session, notification.directory)}
                  class="nav-item notification-item"
                  title={`${notification.kind} · ${notification.editspace}`}
                  onClick={() => openNotification(notification)}
                >
                  <span
                    class={`dot ${dotFor({
                      id: notification.session,
                      updated: notification.updated,
                      pending: notification.kind !== "idle",
                    })}`}
                  />
                  <span class="notification-copy">
                    <span class="nav-title">{notification.title}</span>
                    <span class="notification-meta">
                      {notification.editspace ? `${notification.editspace} · ` : ""}{notification.kind}
                    </span>
                  </span>
                </A>
              )}
            </For>
          </div>
        </Show>
        {/* the board is per project; All has no board until it is redesigned */}
        <Show when={!allProjects()}>
          <A href="/" end activeClass="active" class="nav-item board-link">
            ▦ board
          </A>
        </Show>
        <NewSession />
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
          <Show when={sessionsError()}><div class="err nav-empty">{sessionsError()}</div></Show>
          <Show when={unpinnedSessions().length} fallback={
            <Show when={!sessionsError()}><div class="dim nav-empty">{sessionsLoading() ? "loading..." : pinnedSessions().length ? "All active sessions pinned" : "none"}</div></Show>
          }>
            <For each={unpinnedSessions()}>
              {(s, index) => {
                const day = () => new Date(s.updated).toDateString()
                return (
                  <>
                    <Show when={index() === 0 || day() !== new Date(unpinnedSessions()[index() - 1].updated).toDateString()}>
                      <div class="nav-heading">
                        {day() === new Date().toDateString() ? "Today" : day()}
                      </div>
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

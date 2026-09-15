/* Left nav: the board plus every active session. Collapsed, it becomes a
 * mini icon rail — expand toggle up top (where the switcher lives), board
 * icon, then one status dot per session, still navigable. Archived sessions
 * drop to a collapsed section at the bottom of the expanded view. */
import { createMemo, createSignal, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import { es, type SessionSearchResult } from "../api"
import { sessionHref, useDashboard } from "../state"
import { leftOpen, leftWidth, toggleLeft } from "../ui"

export default function Sidebar() {
  const { state, dotFor, editspace, setEditspace, editspaces, archivedIds, notifications, markViewed } =
    useDashboard()
  const all = (): { id: string; title: string; directory: string; live: string; updated: number }[] =>
    (state()?.threads ?? [])
      .filter((t: any) => t.kind === "session" && t.sessions[0])
      .map((t: any) => t.sessions[0])
  const sessions = createMemo(() =>
    all().filter((s) => !archivedIds().has(s.id)).sort((a, b) => b.updated - a.updated),
  )
  const archived = () => all().filter((s: any) => archivedIds().has(s.id))
  const [showArchived, setShowArchived] = createSignal(false)
  const current = () => editspace() ?? editspaces()?.default ?? state()?.editspace ?? ""
  const openNotification = (item: ReturnType<typeof notifications>[number]) => {
    setEditspace(item.editspace)
    markViewed(item.session, true)
  }

  // transcript search: ≥3 chars, debounced; null results = search inactive
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SessionSearchResult[] | null>(null)
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
      setSearchError("search unavailable — es-dashboard too old?")
    } finally {
      if (seq === searchSeq) setSearching(false)
    }
  }

  const onQuery = (v: string) => {
    setQuery(v)
    setAllTime(false)
    clearTimeout(searchTimer)
    searchSeq++ // invalidate in-flight responses
    if (v.trim().length < 3) {
      setResults(null)
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
        <span class="search-meta">{r.directory.split("/").slice(-2).join("/")}</span>
      </span>
    </A>
  )

  const item = (s: any, cls = "") => (
    <A
      href={sessionHref(s.id, s.directory)}
      activeClass="active"
      class={`nav-item ${cls}`}
      title={`${s.title} (${s.live})`}
    >
      <span class={`dot ${dotFor(s)}`} />
      <span class="nav-title">{s.title || s.id}</span>
    </A>
  )

  return (
    <Show
      when={leftOpen()}
      fallback={
        <nav class="sidebar sidebar-mini">
          <button class="mini-btn" title="expand sidebar (^h)" onClick={toggleLeft}>
            ⟩
          </button>
          <A href="/" end activeClass="active" class="mini-item" title={`board — ${current()}`}>
            ▦
          </A>
          <For each={sessions()}>
            {(s: any) => (
              <A
                href={sessionHref(s.id, s.directory)}
                activeClass="active"
                class="mini-item"
                title={`${s.title} (${s.live})`}
              >
                <span class={`dot ${dotFor(s)}`} />
              </A>
            )}
          </For>
        </nav>
      }
    >
      <nav class="sidebar" style={{ width: `${leftWidth()}px` }}>
        <div class="sidebar-top">
          <select
            class="es-switcher"
            title="editspace"
            value={current()}
            onChange={(e) => setEditspace(e.currentTarget.value)}
          >
            <For each={editspaces()?.editspaces ?? []}>
              {(item) => <option value={item.name}>{item.name}</option>}
            </For>
          </select>
          <button class="mini-btn" title="collapse sidebar (^h)" onClick={toggleLeft}>
            ⟨
          </button>
        </div>
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
                      {notification.editspace} · {notification.kind}
                    </span>
                  </span>
                </A>
              )}
            </For>
          </div>
        </Show>
        <A href="/" end activeClass="active" class="nav-item board-link">
          ▦ board
        </A>
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
          when={results() === null}
          fallback={
            <>
              <div class="nav-heading">
                results{searching() ? " ·" : ` (${results()!.length})`}
              </div>
              <Show when={searchError()}>
                <div class="dim nav-empty">{searchError()}</div>
              </Show>
              <Show when={!searching() && !searchError() && !results()!.length}>
                <div class="dim nav-empty">no matches</div>
              </Show>
              <For each={results()!}>{resultItem}</For>
              <Show when={!allTime() && !searching() && !searchError()}>
                <button class="archived-toggle" onClick={searchAllTime}>
                  ⌕ all time (slow)
                </button>
              </Show>
            </>
          }
        >
          <Show when={sessions().length} fallback={<div class="dim nav-empty">none</div>}>
            <For each={sessions()}>
              {(s, index) => {
                const day = () => new Date(s.updated).toDateString()
                return (
                  <>
                    <Show when={index() === 0 || day() !== new Date(sessions()[index() - 1].updated).toDateString()}>
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
  )
}

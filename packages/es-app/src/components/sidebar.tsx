/* Left nav: the board plus every active session. Collapsed, it becomes a
 * mini icon rail — expand toggle up top (where the switcher lives), board
 * icon, then one status dot per session, still navigable. Archived sessions
 * drop to a collapsed section at the bottom of the expanded view. */
import { createSignal, For, Show } from "solid-js"
import { A } from "@solidjs/router"
import { sessionHref, useDashboard } from "../state"
import { leftOpen, leftWidth, toggleLeft } from "../ui"

export default function Sidebar() {
  const { state, dotFor, editspace, setEditspace, editspaces, archivedIds } = useDashboard()
  const all = () =>
    (state()?.threads ?? [])
      .filter((t: any) => t.kind === "session" && t.sessions[0])
      .map((t: any) => t.sessions[0])
  const sessions = () => all().filter((s: any) => !archivedIds().has(s.id))
  const archived = () => all().filter((s: any) => archivedIds().has(s.id))
  const [showArchived, setShowArchived] = createSignal(false)
  const current = () => editspace() ?? editspaces()?.default ?? state()?.editspace ?? ""

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
        <A href="/" end activeClass="active" class="nav-item board-link">
          ▦ board
        </A>
        <div class="nav-heading">sessions</div>
        <Show when={sessions().length} fallback={<div class="dim nav-empty">none</div>}>
          <For each={sessions()}>{(s: any) => item(s)}</For>
        </Show>
        <Show when={archived().length}>
          <button class="archived-toggle" onClick={() => setShowArchived(!showArchived())}>
            {showArchived() ? "▾" : "▸"} archived ({archived().length})
          </button>
          <Show when={showArchived()}>
            <For each={archived()}>{(s: any) => item(s, "archived")}</For>
          </Show>
        </Show>
      </nav>
    </Show>
  )
}

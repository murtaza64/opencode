/* Left nav: the board plus every active session (the dashboard's displayed
 * session threads, already sorted by meaningful activity). */
import { For, Show } from "solid-js"
import { A } from "@solidjs/router"
import { sessionHref, useDashboard } from "../state"

export default function Sidebar() {
  const { state, dotFor } = useDashboard()
  const sessions = () =>
    (state()?.threads ?? [])
      .filter((t: any) => t.kind === "session" && t.sessions[0])
      .map((t: any) => t.sessions[0])
  return (
    <nav class="sidebar">
      <A href="/" end activeClass="active" class="nav-item board-link">
        ▦ {state()?.editspace ?? "board"}
      </A>
      <div class="nav-heading">sessions</div>
      <Show when={sessions().length} fallback={<div class="dim nav-empty">none</div>}>
        <For each={sessions()}>
          {(s: any) => (
            <A
              href={sessionHref(s.id, s.directory)}
              activeClass="active"
              class="nav-item"
              title={`${s.title} (${s.live})`}
            >
              <span class={`dot ${dotFor(s)}`} />
              <span class="nav-title">{s.title || s.id}</span>
            </A>
          )}
        </For>
      </Show>
    </nav>
  )
}

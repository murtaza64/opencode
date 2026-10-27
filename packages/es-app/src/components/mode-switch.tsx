/* The app's two modes: Front desk (the queue and its chat at "/") and Agents (the session
 * sidebar, with the agent map at /agents as its default page and transcripts under it).
 * Each mode remembers where the reader last was, so switching back returns to the same
 * selected item or session; clicking the current mode's tab returns to that mode's home. */
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { A, useLocation } from "@solidjs/router"
import { Glyph } from "./icons"
import { useDeskQueue } from "../desk-queue"
import { BackendStatus } from "./backend-status"
import { HostSwitch } from "./host-switch"
import { useDashboard } from "../state"
import { deskSessionID } from "../desk-session"

export type Mode = "desk" | "agents"
export const modeOf = (pathname: string): Mode => pathname === "/" ? "desk" : "agents"

const KEY = { desk: "es-app:mode:desk", agents: "es-app:mode:agents" } as const
const HOME = { desk: "/", agents: "/agents" } as const

/** Mounted once in the shell: records the last URL seen in each mode. */
export const trackModes = () => {
  const location = useLocation()
  createEffect(() => sessionStorage.setItem(KEY[modeOf(location.pathname)], location.pathname + location.search + location.hash))
}

export const ModeSwitch = (props: { compact?: boolean }) => {
  const location = useLocation()
  const queue = useDeskQueue()
  const { activity } = useDashboard()
  const current = () => modeOf(location.pathname)
  // The desk chat's own session status from the shared status stream; unknown is not idle, so it shows nothing.
  const [deskID, setDeskID] = createSignal(deskSessionID())
  createEffect(() => { location.pathname; setDeskID(deskSessionID()) })
  const storage = () => setDeskID(deskSessionID())
  addEventListener("storage", storage)
  onCleanup(() => removeEventListener("storage", storage))
  const deskBusy = () => { const id = deskID(); const status = id ? activity.status(id) : undefined; return status === "busy" || status === "retry" }
  const href = (mode: Mode) => {
    location.pathname
    return current() === mode ? HOME[mode] : sessionStorage.getItem(KEY[mode]) ?? HOME[mode]
  }
  // Unread-style: the desk's Needs-you count plus new requested deliverables, shown away from the desk
  // where the queue is out of view.
  const delivered = () => current() === "desk" ? 0 : queue.surfaces.deliverables().fresh.length
  const waiting = () => current() === "desk" ? 0 : queue.items().length + delivered()
  const label = () => [queue.items().length && current() !== "desk" ? `${queue.items().length} need${queue.items().length === 1 ? "s" : ""} you` : "",
    delivered() ? `${delivered()} new deliverable${delivered() === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")
  return <nav class="mode-switch" classList={{ compact: props.compact }} aria-label="Mode">
    <A href={href("desk")} class="mode-tab" aria-current={current() === "desk" ? "page" : undefined} title="Front desk"
      aria-label={waiting() ? `Front desk, ${label()}` : props.compact ? "Front desk" : undefined}>
      {/* The count hangs off the label's end so the label stays centred when it appears. */}
      <span class="mode-label"><Show when={deskBusy()}><span class="mode-busy dot busy" role="status" aria-label="Front desk is working" title="Front desk is working" /></Show>
        <Show when={props.compact} fallback="Front desk"><Glyph name="home" /></Show>
        <Show when={waiting()}><span class="mode-count" aria-hidden="true">{waiting() > 99 ? "99+" : waiting()}</span></Show></span>
    </A>
    <A href={href("agents")} class="mode-tab" aria-current={current() === "agents" ? "page" : undefined} title="Agents" aria-label={props.compact ? "Agents" : undefined}>
      <Show when={props.compact} fallback="Agents"><Glyph name="graph" /></Show>
    </A>
    {/* The mode switch is on every page, so it carries the one app-wide background-read status. */}
    <BackendStatus />
    <HostSwitch compact={props.compact} />
  </nav>
}

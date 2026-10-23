/* The app's two modes: Front desk (the queue and its chat at "/") and Agents (the session
 * sidebar, with the agent map at /agents as its default page and transcripts under it).
 * Each mode remembers where the reader last was, so switching back returns to the same
 * selected item or session; clicking the current mode's tab returns to that mode's home. */
import { createEffect, Show } from "solid-js"
import { A, useLocation } from "@solidjs/router"
import { Glyph } from "./icons"
import { useDeskQueue } from "../desk-queue"
import { BackendStatus } from "./backend-status"

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
  const current = () => modeOf(location.pathname)
  const href = (mode: Mode) => {
    location.pathname
    return current() === mode ? HOME[mode] : sessionStorage.getItem(KEY[mode]) ?? HOME[mode]
  }
  // Unread-style: exactly the desk's Needs-you count, shown away from the desk where the queue is out of view.
  const waiting = () => current() === "desk" ? 0 : queue.items().length
  return <nav class="mode-switch" classList={{ compact: props.compact }} aria-label="Mode">
    <A href={href("desk")} class="mode-tab" aria-current={current() === "desk" ? "page" : undefined} title="Front desk"
      aria-label={waiting() ? `Front desk, ${waiting()} need${waiting() === 1 ? "s" : ""} you` : props.compact ? "Front desk" : undefined}>
      {/* The count hangs off the label's end so the label stays centred when it appears. */}
      <span class="mode-label"><Show when={props.compact} fallback="Front desk"><Glyph name="home" /></Show>
        <Show when={waiting()}><span class="mode-count" aria-hidden="true">{waiting() > 99 ? "99+" : waiting()}</span></Show></span>
    </A>
    <A href={href("agents")} class="mode-tab" aria-current={current() === "agents" ? "page" : undefined} title="Agents" aria-label={props.compact ? "Agents" : undefined}>
      <Show when={props.compact} fallback="Agents"><Glyph name="graph" /></Show>
    </A>
    {/* The mode switch is on every page, so it carries the one app-wide background-read status. */}
    <BackendStatus />
  </nav>
}

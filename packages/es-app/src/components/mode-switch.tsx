/* The app's two modes: Front desk (the queue and its chat at "/") and Agents (the session
 * sidebar, with the agent map at /agents as its default page and transcripts under it).
 * Each mode remembers where the reader last was, so switching back returns to the same
 * selected item or session; clicking the current mode's tab returns to that mode's home. */
import { createEffect, Show } from "solid-js"
import { A, useLocation } from "@solidjs/router"
import { useDashboard } from "../state"
import { Glyph } from "./icons"
import { useBriefs } from "../desk-briefs"

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
  const dashboard = useDashboard()
  const current = () => modeOf(location.pathname)
  const href = (mode: Mode) => {
    location.pathname
    return current() === mode ? HOME[mode] : sessionStorage.getItem(KEY[mode]) ?? HOME[mode]
  }
  const briefs = useBriefs()
  // A dot, not a number: the queue merges sources this count cannot see, so the queue owns the total.
  const waiting = () => dashboard.notifications().some(item => item.kind !== "idle") || briefs.items().length > 0
  return <nav class="mode-switch" classList={{ compact: props.compact }} aria-label="Mode">
    <A href={href("desk")} class="mode-tab" aria-current={current() === "desk" ? "page" : undefined} title="Front desk" aria-label={props.compact ? "Front desk" : undefined}>
      <Show when={props.compact} fallback="Front desk"><Glyph name="home" /></Show>
      <Show when={waiting() && current() !== "desk"}><span class="mode-count" role="img" aria-label="Items waiting" /></Show>
    </A>
    <A href={href("agents")} class="mode-tab" aria-current={current() === "agents" ? "page" : undefined} title="Agents" aria-label={props.compact ? "Agents" : undefined}>
      <Show when={props.compact} fallback="Agents"><Glyph name="graph" /></Show>
    </A>
  </nav>
}

/* The app's two modes and where each mode's tab leads; see components/mode-switch.tsx. */
export type Mode = "desk" | "agents"
export const KEY = { desk: "es-app:mode:desk", agents: "es-app:mode:agents" } as const
export const HOME = { desk: "/", agents: "/agents" } as const
export const modeOf = (pathname: string): Mode => pathname === "/" ? "desk" : "agents"
// Redirect routes (old /desk and /map links) only pass through; recording one as a mode's last place made
// that tab navigate straight back to the other mode.
export const REDIRECTS = new Set(["/desk", "/map"])

/** Where a mode's tab leads: its home when current, else the last place recorded in that mode. A recorded
 * URL that is a redirect or belongs to the other mode falls back to home. */
export const modeHref = (mode: Mode, current: Mode, stored: string | null) => {
  if (current === mode || !stored) return HOME[mode]
  const pathname = new URL(stored, "http://app").pathname
  if (REDIRECTS.has(pathname) || modeOf(pathname) !== mode) return HOME[mode]
  return stored
}

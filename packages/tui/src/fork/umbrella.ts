// fork(session-umbrella): TUI side of the umbrella — fetch the merged
// session universe from the fork's /umbrella/session route and order it for
// the picker: own repo-root sessions foregrounded (stock date categories),
// then the fleet grouped by lane, then sidecar sessions. Non-umbrella
// sessions simply are not in the response; against a stock server the fetch
// 404s and the picker falls back to stock behavior.
import type { Session } from "@opencode-ai/sdk/v2/client"

export type UmbrellaMember = {
  directory: string
  label: string
  kind: "root" | "sidecar" | "lane" | "mirror"
}

export type UmbrellaSession = Session & {
  umbrella: string
  member: UmbrellaMember
}

export async function fetchUmbrellaSessions(input: {
  url: string
  directory?: string
  fetch: typeof fetch
}): Promise<UmbrellaSession[] | undefined> {
  try {
    const headers: Record<string, string> = {}
    if (input.directory) headers["x-opencode-directory"] = encodeURIComponent(input.directory)
    const response = await input.fetch(new URL("/umbrella/session", input.url).toString(), { headers })
    if (!response.ok) return undefined
    const sessions = (await response.json()) as UmbrellaSession[]
    if (!Array.isArray(sessions) || sessions.length === 0) return undefined
    return sessions
  } catch {
    return undefined
  }
}

// Display stays flat and activity-time sorted with stock date categories —
// the picker's existing recency ordering applies to the umbrella universe
// unchanged (decision 2026-07-08: no member sections; per-entry chips carry
// the location instead).

/**
 * Picker footer chip for a session's umbrella member. Location-based, not
 * viewer-relative — the universe looks identical from every member:
 *   lane     -> `lane:<name>`
 *   sidecar  -> `editspace`
 *   mirror   -> `mirror` (multi-repo root mirror — read-only, sessions
 *               there are unusual and worth flagging)
 *   root     -> `root`
 */
export function memberChip(member: UmbrellaMember): string {
  if (member.kind === "lane") return `lane:${member.label}`
  if (member.kind === "sidecar") return "editspace"
  if (member.kind === "mirror") return "mirror"
  return "root"
}

/**
 * Chips per session id for the picker. Chips exist to disambiguate location,
 * so an umbrella whose universe is all-root (a project with no editspace
 * machinery in play) gets none — including no `root` chip. Sessions absent
 * from the map keep stock chip behavior.
 */
export function memberChips(sessions: readonly UmbrellaSession[] | undefined): Map<string, string> {
  const chips = new Map<string, string>()
  if (!sessions) return chips
  if (!sessions.some((session) => session.member.kind !== "root")) return chips
  for (const session of sessions) chips.set(session.id, memberChip(session.member))
  return chips
}

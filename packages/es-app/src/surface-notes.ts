/* A Surface's change notes (DD #725): the author's note per revision (`es surface publish --whats-new`), and what this
 * device last opened, so a reader can say what changed since then. A note is only ever the author's text for its own
 * revision; nothing is inferred from timestamps, and the latest note never stands in for revisions it does not cover. */
import type { Surface } from "./surfaces"

export type SurfaceNote = { revision: number; text?: string; at?: number }

/** One line for a list row: the current revision's note, "No change note provided" for a republish without one, and
 * nothing for a first publish without one (there is no change to describe). */
export const changeNoteLine = (surface: Pick<Surface, "revision" | "whats_new">) =>
  surface.whats_new ?? (surface.revision > 1 ? "No change note provided" : undefined)

/** What a reader shows for `surface` when this device last opened revision `opened` (undefined: never). `since` is set
 * only when revisions were missed: the earlier notes after `opened`, newest first, and how many missed revisions have
 * no note at all. */
export const changeNotes = (surface: Pick<Surface, "revision" | "whats_new" | "notes" | "change">, opened?: number) => {
  const current = changeNoteLine(surface)
  // The note covers its base (the author's --whats-base, default the previous revision) to now: a device that last
  // opened an older revision than the base missed changes the note does not describe.
  const base = surface.change?.base ?? surface.revision - 1
  if (opened === undefined || opened >= base) return { current }
  const earlier = (surface.notes ?? []).filter((note): note is typeof note & { text: string } => !!note.text && note.revision > opened && note.revision < surface.revision)
    .toSorted((a, b) => b.revision - a.revision)
  return { current, since: { base: opened, earlier, unnoted: surface.revision - 1 - opened - earlier.length } }
}

// The revision of each Surface this device last showed in a reader, per host (local: "").
const KEY = "es-app:surface-opened:1"
type Opened = Record<string, number>

const read = (): Opened => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export const openedRevision = (host: string, id: string): number | undefined => {
  const value = read()[`${host}~${id}`]
  return Number.isInteger(value) ? value : undefined
}

export const markOpened = (host: string, id: string, revision: number) => {
  const all = read()
  const key = `${host}~${id}`
  if ((all[key] ?? 0) >= revision) return
  // Bounded: the newest 300 Surfaces opened on this device.
  const kept = Object.entries({ ...all, [key]: revision }).slice(-300)
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // Storage full or blocked: the next open simply has no comparison base.
  }
}

const INTENT = { fyi: "FYI", review: "Review", decision: "Decision" } as const

/** The call-to-action parts of the current revision (DD #753): "Since r10", its intent and the first places to look.
 * Empty when the author said none of them, so a row never invents a reason to look. */
export const changeCall = (surface: Pick<Surface, "revision" | "change">) => {
  const change = surface.change
  if (!change || (!change.intent && !change.look.length && !change.respond)) return []
  const look = change.look.length ? `Look at: ${change.look[0]!.label}${change.look.length > 1 ? ` +${change.look.length - 1}` : ""}` : undefined
  return [change.base ? `Since r${change.base}` : undefined, change.intent ? INTENT[change.intent] : undefined, look].filter((part): part is string => !!part)
}

export const intentLabel = (intent: keyof typeof INTENT | null | undefined) => intent ? INTENT[intent] : undefined

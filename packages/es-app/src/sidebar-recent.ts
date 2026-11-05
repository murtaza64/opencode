/* The unified sidebar's Recent order and this device's memory of what it opened.
 * Recent blends agents, Surfaces and closed decisions. Blended (the default) puts anything that
 * changed since this device last opened it first, then the most recently opened. The alternatives
 * are plain Opened (MRU) and Updated. Ordering is presentation only: it reads timestamps it is
 * given and never infers a change from an id or a title. */
import { createSignal } from "solid-js"

export type RecentKind = "agent" | "surface" | "decision"
export type RecentOrder = "blended" | "opened" | "updated"

export type RecentItem = {
  kind: RecentKind
  /** Unique across kinds and hosts. */
  key: string
  title: string
  /** When the source says it last changed; absent when it does not say. */
  updated?: number
  /** When this device last opened it; absent when never. */
  opened?: number
}

export const ORDER_LABEL: Record<RecentOrder, string> = { blended: "Blended", opened: "Opened", updated: "Updated" }
export const ORDER_MODES: RecentOrder[] = ["blended", "opened", "updated"]

/** Changed since this device last opened it. Never opened counts as changed: it is new to you. */
export const changedSinceOpened = (item: Pick<RecentItem, "updated" | "opened">) =>
  item.updated !== undefined && (item.opened === undefined || item.updated > item.opened)

// `undefined` always sorts last; ties fall through to the next comparison, then the key, so the
// order is total and stable for equal timestamps.
const by = (a: number | undefined, b: number | undefined) => a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : b - a

export const recentOrder = <T extends RecentItem>(items: readonly T[], mode: RecentOrder): T[] => {
  const sorted = [...items]
  if (mode === "updated") return sorted.sort((a, b) => by(a.updated, b.updated) || by(a.opened, b.opened) || a.key.localeCompare(b.key))
  if (mode === "opened") return sorted.sort((a, b) => by(a.opened, b.opened) || by(a.updated, b.updated) || a.key.localeCompare(b.key))
  // Blended: changed-since-opened first (most recent change first), then MRU, then last update.
  return sorted.sort((a, b) => {
    const af = changedSinceOpened(a) ? 0 : 1
    const bf = changedSinceOpened(b) ? 0 : 1
    if (af !== bf) return af - bf
    if (af === 0) return by(a.updated, b.updated) || a.key.localeCompare(b.key)
    return by(a.opened, b.opened) || by(a.updated, b.updated) || a.key.localeCompare(b.key)
  })
}

/** The chips: All is the blended list; the others narrow by kind. Decisions also carries requests. */
export type SidebarFilter = "all" | "agents" | "surfaces" | "decisions"
export const FILTERS: [SidebarFilter, string][] = [["all", "All"], ["agents", "Agents"], ["surfaces", "Surfaces"], ["decisions", "Decisions"]]
export const kindMatches = (filter: SidebarFilter, kind: RecentKind) =>
  filter === "all" || (filter === "agents" && kind === "agent") || (filter === "surfaces" && kind === "surface") || (filter === "decisions" && kind === "decision")

/** Keys in `next` that were not in `shown`, in their new order. */
export const newcomers = (shown: readonly string[], next: readonly string[]) => {
  const seen = new Set(shown)
  return next.filter((key) => !seen.has(key))
}

/** Keep the shown order for rows that still exist, so a refetch never reorders under the pointer;
 * rows that left simply go, and new rows are reported separately for the "N new" pill. */
export const holdOrder = (shown: readonly string[], next: readonly string[]) => {
  const present = new Set(next)
  return shown.filter((key) => present.has(key))
}

const OPENED_KEY = "es-app:sidebar-opened:1"
const ORDER_KEY = "es-app:sidebar-order"
const DENSITY_KEY = "es-app:sidebar-density"

const readOpened = (): Record<string, number> => {
  try {
    const value = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

const [opened, setOpened] = createSignal<Record<string, number>>(readOpened())

/** When this device last opened `key`, or undefined. Reactive: a new open re-renders the list. */
export const openedAt = (key: string) => opened()[key]

/** Remember that a row was opened (a click, not a hover or a preview). */
export const markSidebarOpened = (key: string) => {
  const next = { ...opened(), [key]: Date.now() }
  // Bounded: the newest 300 rows opened on this device.
  const kept = Object.fromEntries(Object.entries(next).toSorted((a, b) => a[1] - b[1]).slice(-300))
  setOpened(kept)
  try { localStorage.setItem(OPENED_KEY, JSON.stringify(kept)) } catch { /* kept for this page */ }
}

export const readOrder = (): RecentOrder => {
  try {
    const value = localStorage.getItem(ORDER_KEY)
    return value === "opened" || value === "updated" ? value : "blended"
  } catch {
    return "blended"
  }
}

export const writeOrder = (value: RecentOrder) => {
  try { localStorage.setItem(ORDER_KEY, value) } catch { /* kept for this page */ }
}

export type Density = "compact" | "expanded"

export const readDensity = (): Density => {
  try {
    return localStorage.getItem(DENSITY_KEY) === "expanded" ? "expanded" : "compact"
  } catch {
    return "compact"
  }
}

export const writeDensity = (value: Density) => {
  try { localStorage.setItem(DENSITY_KEY, value === "expanded" ? "expanded" : "compact") } catch { /* kept for this page */ }
}

/* Last-seen Work view rows per host, so a reload while a host is down still lists what it last
 * showed (marked unavailable, with its age) instead of an empty list. Bounded and minimal: session id,
 * title, directory and update time only; no transcripts, drafts or counts. Each origin is one profile's
 * storage, so Work and Personal never share it. */

const MAX_ROWS = 200
export type SeenRow = { id: string; title: string; directory: string; updated: number }
type RowLike = { id: string; title?: string; directory?: string; updated?: number }
/** `project`: the project the rows were narrowed to (undefined = all projects); used only for that view. */
export type Seen = { rows: SeenRow[]; cachedAt: number; project?: string }

/** This host's key (`local`) or another Work host's. */
const key = (host: string) => (host === "local" ? "es-app-work-rows" : `host:${host}:es-app-work-rows`)

export const saveSeen = (host: string, rows: RowLike[], project: string | undefined, at = Date.now()) => {
  // Some rows carry no update time; they keep their order after the dated ones, saved as 0.
  const kept = rows.map((row) => ({ id: row.id, title: row.title ?? "", directory: row.directory ?? "", updated: typeof row.updated === "number" ? row.updated : 0 }))
    .sort((a, b) => b.updated - a.updated).slice(0, MAX_ROWS)
  try {
    localStorage.setItem(key(host), JSON.stringify({ rows: kept, cachedAt: at, ...(project ? { project } : {}) }))
  } catch {
    // Storage full or unavailable: the live list still works; only the reload fallback is lost.
  }
}

/** `project` "*" accepts the rows whatever project they were listed for (used when the project is not known yet). */
export const loadSeen = (host: string, project: string | undefined | "*"): Seen | undefined => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(host)) ?? "null")
    if (!value || typeof value !== "object") return undefined
    const record = value as { rows?: unknown; cachedAt?: unknown; project?: unknown }
    if (!Array.isArray(record.rows) || typeof record.cachedAt !== "number") return undefined
    const listed = typeof record.project === "string" ? record.project : undefined
    if (project !== "*" && listed !== project) return undefined
    const rows = record.rows.flatMap((row: Record<string, unknown>) =>
      row && typeof row.id === "string" && typeof row.title === "string" && typeof row.directory === "string" && typeof row.updated === "number"
        ? [{ id: row.id, title: row.title, directory: row.directory, updated: row.updated }] : [])
    return { rows: rows.slice(0, MAX_ROWS), cachedAt: record.cachedAt, ...(listed ? { project: listed } : {}) }
  } catch {
    return undefined
  }
}

/** Drop the cache of hosts no longer in the Work view (removed or unpaired). */
export const forgetSeen = (keep: string[]) => {
  const prefix = /^host:([a-z][a-z0-9-]{0,31}):es-app-work-rows$/
  for (const name of Object.keys(localStorage)) {
    const match = prefix.exec(name)
    if (match && !keep.includes(match[1]!)) localStorage.removeItem(name)
  }
}

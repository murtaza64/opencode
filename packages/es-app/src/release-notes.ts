/* What's new for this native app release (META-08). The listener serves the notes bundled with the running
 * build and whether this release was already seen (one app-level mark, shared across hosts, views and profiles).
 * 404 (web-only, paired, gateway) and anything malformed mean no notes. */

export type ReleaseItem = { title: string; detail?: string; try?: { label: string; href: string; internal: boolean } }
export type ReleaseNotes = { release: string; items: ReleaseItem[]; limits: string[] }
export type ReleaseNotesState = { release?: string; notes: ReleaseNotes | null; seen: boolean }

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined

// In-app routes open in this window; http(s) links open outside it; anything else is dropped.
const tryLink = (value: unknown): ReleaseItem["try"] => {
  if (!value || typeof value !== "object") return
  const spec = value as { label?: unknown; href?: unknown }
  const label = text(spec.label, 60)
  const href = text(spec.href, 2000)
  if (!label || !href) return
  if (href.startsWith("/") && !href.startsWith("//")) return { label, href, internal: true }
  if (/^https?:\/\/[^\s]+$/.test(href)) return { label, href, internal: false }
}

/** The notes when they are release-notes/1 for exactly `release`; otherwise null. */
export const parseReleaseNotes = (value: unknown, release: string | undefined): ReleaseNotes | null => {
  if (!value || typeof value !== "object" || !release) return null
  const body = value as { schema?: unknown; release?: unknown; items?: unknown; limits?: unknown }
  if (body.schema !== "release-notes/1" || body.release !== release || !Array.isArray(body.items)) return null
  const items = body.items.slice(0, 8).flatMap((raw): ReleaseItem[] => {
    if (!raw || typeof raw !== "object") return []
    const item = raw as { title?: unknown; detail?: unknown; try?: unknown }
    const title = text(item.title, 120)
    if (!title) return []
    const detail = text(item.detail, 400)
    const link = tryLink(item.try)
    return [{ title, ...(detail ? { detail } : {}), ...(link ? { try: link } : {}) }]
  })
  const limits = (Array.isArray(body.limits) ? body.limits : []).slice(0, 5).flatMap((raw) => text(raw, 200) ?? [])
  return items.length ? { release, items, limits } : null
}

export const readReleaseNotes = async (): Promise<ReleaseNotesState> => {
  const response = await fetch("/__es/release-notes", { cache: "no-store" }).catch(() => undefined)
  if (!response?.ok) return { notes: null, seen: true }
  const body = await response.json().catch(() => undefined) as { release?: unknown; notes?: unknown; seen?: unknown } | undefined
  const release = typeof body?.release === "string" ? body.release : undefined
  return { release, notes: parseReleaseNotes(body?.notes, release), seen: body?.seen === true }
}

/** Marks this release seen; a refused mark (stale release) leaves it for the next start, which is harmless. */
export const markReleaseNotesSeen = (release: string) =>
  fetch("/__es/release-notes/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ release }) }).then(() => undefined, () => undefined)

/* What's new in this app release (release-notes/1): authored at cut time as packages/es-desktop/release-notes.json and
 * bundled by the build, beside build-info.json naming the release the publisher built (ES_RELEASE). Notes show only
 * for the release they were written for: a missing or invalid file, or notes for another release, is no notes. Whether
 * the operator has seen this release's notes is one app-level preference, shared by every view and host tab. */
import { readFile, rename, writeFile } from "node:fs/promises"
import { appRouteURL, externalURL } from "./policy"

export type ReleaseItem = { title: string; detail?: string; try?: { label: string; href: string } }
export type ReleaseNotes = { schema: "release-notes/1"; release: string; items: ReleaseItem[]; limits: string[] }

// Any app origin: a relative route is checked by its path alone.
const BASE = "http://127.0.0.1:60302"
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/** `notes`, `buildInfo`: the bundled files; `seen`: the preference file in the app's user data. */
export const createReleaseNotes = async (options: { notes: string; buildInfo: string; seen: string }) => {
  const [rawNotes, rawInfo, rawSeen] = await Promise.all([options.notes, options.buildInfo, options.seen].map(readJSON))
  const info = rawInfo && typeof rawInfo === "object" ? (rawInfo as Record<string, unknown>).release : undefined
  const release = typeof info === "string" && RELEASE.test(info) ? info : undefined
  const parsed = release ? releaseNotesOf(rawNotes) : undefined
  const notes = parsed?.release === release ? parsed : undefined
  const stored = rawSeen && typeof rawSeen === "object" ? (rawSeen as Record<string, unknown>).release : undefined
  const state = { seen: typeof stored === "string" ? stored : undefined }
  return {
    /** This release, its notes (null when none apply) and whether the operator has seen them. */
    read: () => ({ release: release ?? null, notes: notes ?? null, seen: !!release && state.seen === release }),
    /** Records that this release's notes were seen; any other release is refused, so a stale page cannot mark a newer one. */
    markSeen: async (value: string) => {
      if (!release || value !== release) return false
      if (state.seen === release) return true
      // Write then rename, so a reader never sees a partial file.
      await writeFile(`${options.seen}.tmp`, JSON.stringify({ release }), { mode: 0o600 })
      await rename(`${options.seen}.tmp`, options.seen)
      state.seen = release
      return true
    },
  }
}

export type ReleaseNotesStore = Awaited<ReturnType<typeof createReleaseNotes>>

/** release-notes/1 with every field bounded; a `try` link must be a relative app route (it opens on whichever host tab
 * shows the notes) or a plain external link. */
export const releaseNotesOf = (raw: unknown): ReleaseNotes | undefined => {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  if (record.schema !== "release-notes/1" || typeof record.release !== "string" || !RELEASE.test(record.release)) return undefined
  if (!Array.isArray(record.items) || record.items.length > 8 || (record.limits !== undefined && (!Array.isArray(record.limits) || record.limits.length > 5))) return undefined
  const items = record.items.map(itemOf)
  const limits = ((record.limits ?? []) as unknown[]).map((item) => text(item, 300))
  if (items.some((item) => !item) || limits.some((item) => item === undefined)) return undefined
  return { schema: "release-notes/1", release: record.release, items: items as ReleaseItem[], limits: limits as string[] }
}

const itemOf = (raw: unknown): ReleaseItem | undefined => {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const title = text(record.title, 120)
  const detail = record.detail === undefined ? undefined : text(record.detail, 600)
  if (!title || (record.detail !== undefined && !detail)) return undefined
  if (record.try === undefined) return { title, ...(detail ? { detail } : {}) }
  const link = record.try && typeof record.try === "object" ? (record.try as Record<string, unknown>) : {}
  const label = text(link.label, 60)
  const href = typeof link.href === "string" ? (link.href.startsWith("/") && !link.href.startsWith("//") ? appRouteURL(new URL(link.href, BASE).href, BASE) && link.href : externalURL(link.href)) : undefined
  if (!label || !href) return undefined
  return { title, ...(detail ? { detail } : {}), try: { label, href } }
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() && value.length <= max ? value : undefined)

const readJSON = (file: string) => readFile(file, "utf8").then((value): unknown => JSON.parse(value)).catch(() => undefined)

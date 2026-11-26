// Human-facing absolute times, always on the VIEWING device's locale and time zone (Intl default), never the host
// that owns the item. One place, so a Mini-hosted item read on the Laptop shows Laptop time everywhere. Relative ages
// stay in `ago`. Machine strings (ISO in prompts, <time dateTime>) keep using toISOString.

const valid = (at: number | string | Date | null | undefined) => {
  if (at === null || at === undefined) return undefined
  const value = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at)
  return Number.isFinite(value) ? value : undefined
}
const formatter = (options: Intl.DateTimeFormatOptions) => (at: number | string | Date | null | undefined, fallback = "") => {
  const value = valid(at)
  return value === undefined ? fallback : new Intl.DateTimeFormat(undefined, options).format(value)
}

/** "10:24 AM" */
export const clockTime = formatter({ hour: "2-digit", minute: "2-digit" })
/** "Nov 3, 10:24 AM" */
export const shortDateTime = formatter({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
/** "Tue 10:24 AM" */
export const weekdayTime = formatter({ weekday: "short", hour: "2-digit", minute: "2-digit" })
/** "Nov 3, 2026, 10:24:42 AM" (the old toLocaleString shape) */
export const dateTime = formatter({ year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })
/** "Nov 3" */
export const dayLabel = formatter({ month: "short", day: "numeric" })
/** "Tuesday, November 3, 2026 at 10:24:42 AM EST" */
export const fullDateTime = formatter({ dateStyle: "full", timeStyle: "long" })

/** ISO 8601 in the device's own offset, e.g. 2026-11-03T10:24:42-05:00. */
export const localISO = (at: number | string | Date | null | undefined) => {
  const value = valid(at)
  if (value === undefined) return ""
  const date = new Date(value)
  const offset = -date.getTimezoneOffset()
  const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, "0")
  const zone = offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`
}

/** Hover and aria text for a short clock: the full local date and time, then the exact ISO with offset, labelled. */
export const exactTime = (at: number | string | Date | null | undefined) => {
  const value = valid(at)
  return value === undefined ? "" : `${fullDateTime(value)} (exact: ${localISO(value)})`
}

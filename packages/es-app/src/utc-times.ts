import { clockTime, exactTime } from "./local-time"

// Agent prose often states times in UTC ("10:24Z", "2026-11-03T10:24:42Z"). In rendered message markdown, an
// unambiguous UTC or offset time gets a dotted underline and a hover/description with the reader's local time; the
// text itself never changes. Code, preformatted text and anything outside markdown (tool output) are left alone, and
// bare times without a zone are ambiguous, so they are not touched. A clock without a date ("10:24Z") is converted as
// a time of day only, so no date is claimed.

const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})(?![\w:])/g
const CLOCK = /\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?Z\b/g
const ANY = new RegExp(`${ISO.source}|${CLOCK.source}`, "g")

/** The reader's local reading of one token, or undefined when it is not a time. */
export const localReading = (token: string, now = Date.now()) => {
  if (/^\d{4}-/.test(token)) {
    const at = Date.parse(token)
    return Number.isFinite(at) ? `Your time: ${exactTime(at)}` : undefined
  }
  const [hours, minutes, seconds] = token.slice(0, -1).split(":").map(Number)
  const day = new Date(now)
  const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes, seconds ?? 0)
  return `Your time: ${clockTime(at)} (time of day; ${token} is UTC)`
}

export function wrapUtcTimes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      ANY.lastIndex = 0
      if (!ANY.test(node.nodeValue ?? "")) return NodeFilter.FILTER_SKIP
      const parent = node.parentElement
      if (!parent || !parent.closest('[data-component="markdown"]') || parent.closest("code, pre, kbd, samp, abbr.utc-time, textarea, script, style"))
        return NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const targets: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node as Text)
  for (const text of targets) {
    const value = text.nodeValue ?? ""
    const fragment = document.createDocumentFragment()
    let last = 0
    ANY.lastIndex = 0
    for (let match = ANY.exec(value); match; match = ANY.exec(value)) {
      const reading = localReading(match[0])
      if (!reading) continue
      fragment.appendChild(document.createTextNode(value.slice(last, match.index)))
      const abbr = document.createElement("abbr")
      abbr.className = "utc-time"
      abbr.title = reading
      abbr.textContent = match[0]
      fragment.appendChild(abbr)
      last = match.index + match[0].length
    }
    if (!last) continue
    fragment.appendChild(document.createTextNode(value.slice(last)))
    text.replaceWith(fragment)
  }
}

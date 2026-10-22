/* Session message anchors: `/session/<id>?directory=<dir>&message=<msgID>[&to=<msgID>]`
 * opens the session scrolled to one message, or to an inclusive range. */

export type MessageAnchor = { message: string; to?: string }

export const parseAnchor = (search: { message?: string | string[]; to?: string | string[] }): MessageAnchor | undefined => {
  const message = Array.isArray(search.message) ? search.message[0] : search.message
  if (!message) return
  const to = Array.isArray(search.to) ? search.to[0] : search.to
  return { message, ...(to && to !== message ? { to } : {}) }
}

// Message IDs are opaque; reject only values that cannot be a single path segment.
export const anchorValid = (id: string) => /^[\w-]{1,128}$/.test(id)

export const anchorHref = (sessionID: string, directory: string, message: string, to?: string) =>
  `/session/${sessionID}?directory=${encodeURIComponent(directory)}&message=${encodeURIComponent(message)}${
    to && to !== message ? `&to=${encodeURIComponent(to)}` : ""}`

/** IDs to highlight, in transcript order, for the found ends of an anchor. Ends may be given in either order. */
export const anchorRange = (ids: readonly string[], anchor: MessageAnchor, found: (id: string) => boolean) => {
  const ends = [anchor.message, anchor.to].filter((id): id is string => !!id && found(id) && ids.includes(id))
  if (!ends.length) return []
  const positions = ends.map((id) => ids.indexOf(id))
  return ids.slice(Math.min(...positions), Math.max(...positions) + 1)
}

/** Unobtrusive note for anchor ends that could not be shown; empty when everything resolved. */
export const anchorNote = (anchor: MessageAnchor, missing: readonly string[], failed: boolean) => {
  if (failed) return "Couldn't load the linked message. Showing the latest messages."
  const start = missing.includes(anchor.message)
  const end = !!anchor.to && missing.includes(anchor.to)
  if (start && (end || !anchor.to)) return anchor.to
    ? "Linked messages aren't in this session. Showing the latest messages."
    : "Linked message isn't in this session. Showing the latest messages."
  if (start) return "Start of the linked range isn't in this session. Showing its end."
  if (end) return "End of the linked range isn't in this session. Showing its start."
  return ""
}

/* Which earlier sessions read as one transcript with this one (DD #857/#858, ux-feel continuous-transcript.md).
 * Only verified records count: a lane's handoff edges, or the Front Desk pointer's predecessors cross-checked against
 * each successor's own succession record. Never titles, timestamps or parentID. Nothing here writes. */
import type { Handoff } from "./handoffs"
import type { SessionHost } from "./session-host"

/** One earlier session, newest first in a chain. `host` absent = the reader's own host. */
export type ChainLink = { session: string; directory?: string; host?: SessionHost & { id: string; label: string }; reason?: string; until?: number }
/** `broken`: why the chain stops before its true start, shown as "Earlier history isn't linked". */
export type Chain = { links: ChainLink[]; broken?: "ambiguous" | "cycle" | "mismatch" }

const LIMIT = 50

/** A lane session's predecessors through its own lane's handoff edges, nearest first. Two edges into one session,
 * a change of lane or a repeat end the chain with a note. */
export const laneChain = (sessionID: string, edges: readonly Handoff[]): Chain => {
  const links: ChainLink[] = []
  const seen = new Set([sessionID])
  let current = sessionID
  let lane: string | undefined
  while (links.length < LIMIT) {
    const prior = edges.filter((edge) => edge.successor === current)
    if (!prior.length) return { links }
    if (prior.length > 1 || (lane !== undefined && prior[0]!.lane !== lane)) return { links, broken: "ambiguous" }
    const edge = prior[0]!
    if (seen.has(edge.predecessor)) return { links, broken: "cycle" }
    seen.add(edge.predecessor)
    lane = edge.lane
    links.push({ session: edge.predecessor, ...(edge.reason ? { reason: edge.reason } : {}) })
    current = edge.predecessor
  }
  return { links }
}

/** The desk's earlier sessions from the home pointer (`earlier`: newest first, home entries only). A successor that
 * names its predecessor (metadata.frontDesk.succession) must name the next one; a successor without that record (older
 * desks) is trusted to the pointer alone. */
export const deskChain = (sessionID: string, earlier: readonly ChainLink[], successionOf: (session: string) => string | undefined): Chain => {
  const links: ChainLink[] = []
  const seen = new Set([sessionID])
  let successor = sessionID
  for (const link of earlier.slice(0, LIMIT)) {
    if (seen.has(link.session)) return { links, broken: "cycle" }
    const named = successionOf(successor)
    if (named !== undefined && named !== link.session) return { links, broken: "mismatch" }
    seen.add(link.session)
    links.push(link)
    successor = link.session
  }
  return { links }
}

/** The successor's recorded predecessor, from Core session metadata. */
export const successionPredecessor = (metadata: unknown): string | undefined => {
  const desk = (metadata as { frontDesk?: { succession?: { predecessor?: unknown } } } | undefined)?.frontDesk
  const value = desk?.succession?.predecessor
  return typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value) ? value : undefined
}

/** Synthetic handoff plumbing that reads as part of the seam, not as conversation: the successor's seed and the
 * predecessor's brief request. Collapsed, never hidden or rewritten. */
export const HANDOFF_SOURCES = new Set(["front-desk/succession", "front-desk/succession-brief-request"])
export const handoffPlumbing = (parts: readonly { type: string; metadata?: Record<string, unknown> }[]) =>
  parts.length > 0 && parts.some((part) => part.type === "text" && HANDOFF_SOURCES.has(String(part.metadata?.source ?? "")))

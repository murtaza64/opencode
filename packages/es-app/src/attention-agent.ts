/* Which agent asked: an attention record names its requester by the immutable
 * `origin_session`, never by whoever prepared a brief for it. A requester that
 * has since handed off still asked the question; where an answer goes now is
 * shown separately, and only through verified handoff lineage. */
import type { AttentionRecord } from "./attention"
import { successorFor, type Handoff, type LaneOwner } from "./handoffs"

export type AgentRef = { session: string; label: string; named: boolean; directory?: string }
export type RequestAgent = AgentRef & {
  lane?: string
  /** Latest content author, when another session updated the request. */
  author?: AgentRef
  /** Current lane owner reached from the requester by verified handoffs, when it is a different session. */
  destination?: AgentRef
}

export type AgentSources = {
  session: (id: string) => { title?: string; directory?: string } | undefined
  /** Dashboard lineage: lane keys are `JSON.stringify([editspace, lane])`. */
  handoffs: readonly Handoff[]
  owners: readonly LaneOwner[]
}

const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const requestAgent = (record: AttentionRecord, sources: AgentSources): RequestAgent => {
  const lane = record.lane || undefined
  const ref = (session: string, directory?: string): AgentRef => {
    const known = sources.session(session)
    const title = known?.title?.trim()
    const named = !!title && !DEFAULT_TITLE.test(title)
    // An untitled session is known by its lane, never by a guessed alias.
    return { session, label: named ? title! : lane ?? "Unknown agent", named, directory: known?.directory ?? directory }
  }
  const origin = record.origin_session
  const requester = ref(origin, record.source_ref.session_id === origin ? record.source_ref.directory : undefined)
  const author = record.producer_session && record.producer_session !== origin
    ? ref(record.producer_session, record.source_ref.session_id === record.producer_session ? record.source_ref.directory : undefined)
    : undefined
  const tip = lane ? successorFor(origin, [...sources.handoffs], [...sources.owners]) : undefined
  const destination = tip && tip.lane === JSON.stringify([record.editspace, lane]) && tip.successor !== origin
    ? ref(tip.successor)
    : undefined
  return { ...requester, lane, ...(author ? { author } : {}), ...(destination ? { destination } : {}) }
}

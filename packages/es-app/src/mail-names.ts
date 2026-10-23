/* Display names for mail parties. Mail addresses lanes; people know the agents
 * by their session titles (e.g. "Relay" for the orchestrator lane). A lane
 * shows its owner's title only when the session that actually sent or received
 * the mail is that owner, or reaches it through verified handoff lineage.
 * Display only: routing, receipts and authority keep the lane address. */
import { successorFor, type Handoff, type LaneOwner } from "./handoffs"

export type MailName = { label: string; title: string; named: boolean }
/** Resolve a mail party (lane, `human`, or session ID) given the session that sent or received the mail, if recorded. */
export type MailNamer = ((party: string, evidence?: string | null) => MailName) & {
  /** Whether `party` is a lane this client knows (for origin labels). */
  local?: (party: string) => boolean
}

export type MailNameSources = {
  editspace: string
  /** Lane keys are `JSON.stringify([editspace, lane])`, as in dashboard lineage. */
  owners: readonly LaneOwner[]
  handoffs: readonly Handoff[]
  title: (sessionID: string) => string | undefined
}

const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SESSION = /^ses_[\w-]+$/

export const mailName = (sources: MailNameSources, party: string, evidence?: string | null): MailName => {
  const familiar = (sessionID: string) => {
    const title = sources.title(sessionID)?.trim()
    return title && !DEFAULT_TITLE.test(title) ? title : undefined
  }
  if (party === "human") return { label: party, title: "Human", named: false }
  if (SESSION.test(party)) {
    const title = familiar(party)
    return title ? { label: title, title: `Session ${party}`, named: true } : { label: party, title: `Session ${party}`, named: false }
  }
  const fallback = { label: party, title: evidence ? `Lane ${party} · session ${evidence}` : `Lane ${party}`, named: false }
  // A lane of another editspace is addressed `<editspace>/<lane>` (es cross-editspace mail).
  const remote = /^([^/]+)\/([^/]+)$/.exec(party)
  const key = JSON.stringify(remote ? [remote[1], remote[2]] : [sources.editspace, party])
  const owners = sources.owners.filter((owner) => owner.lane === key)
  if (owners.length !== 1 || !evidence) return fallback
  const owner = owners[0]!.owner
  const continuous = evidence === owner || successorFor(evidence, [...sources.handoffs], [...sources.owners])?.successor === owner
  const title = continuous ? familiar(owner) : undefined
  if (!title) return fallback
  return { label: title, title: `Lane ${party} · session ${evidence === owner ? owner : `${evidence} → ${owner}`}`, named: true }
}

export const mailNamer = (sources: () => MailNameSources | undefined): MailNamer => Object.assign(
  (party: string, evidence?: string | null) => {
    const current = sources()
    return current ? mailName(current, party, evidence) : { label: party, title: party, named: false }
  },
  {
    local: (party: string) => {
      const current = sources()
      return !!current && current.owners.some((owner) => owner.lane === JSON.stringify([current.editspace, party]))
    },
  },
)

/** The session recorded as receiving `message` for `recipient`, when exactly one is recorded. */
export const recipientSession = (deliveries: readonly { recipient: string; session: string | null }[], recipient: string) => {
  const sessions = [...new Set(deliveries.filter((delivery) => delivery.recipient === recipient && delivery.session).map((delivery) => delivery.session!))]
  return sessions.length === 1 ? sessions[0] : undefined
}

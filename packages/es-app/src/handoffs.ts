export type Handoff = { lane: string; predecessor: string; successor: string; reason?: string; kickoff?: "skipped"; context?: string }
export type PendingHandoff = {
  lane: string
  predecessor: string
  successor?: string | null
  status: string
  request_id: string
  error?: string | null
  reason?: string
}
export type LaneOwner = { lane: string; owner: string }

// A lane owner is the authoritative tip. Never infer succession from timestamps,
// titles, or parentID (which denotes a subagent/fork relationship).
export const successorFor = (sessionID: string, handoffs: Handoff[], owners: LaneOwner[]) => {
  const visited = new Set([sessionID])
  let current = sessionID
  let lane: string | undefined
  while (true) {
    const edges = handoffs.filter((edge) => edge.predecessor === current)
    if (edges.length !== 1 || (lane && edges[0]!.lane !== lane) || visited.has(edges[0]!.successor)) return
    lane = edges[0]!.lane
    current = edges[0]!.successor
    visited.add(current)
    const matches = owners.filter((owner) => owner.lane === lane)
    if (matches.length === 1 && matches[0]!.owner === current && !handoffs.some((edge) => edge.predecessor === current))
      return { lane, predecessor: sessionID, successor: current }
  }
}

export const handoffChain = (sessionID: string, handoffs: Handoff[]) => {
  const prior = handoffs.filter((edge) => edge.successor === sessionID)
  return prior.length === 1 ? prior[0] : undefined
}

export const handoffNext = (sessionID: string, handoffs: Handoff[]) => {
  const next = handoffs.filter((edge) => edge.predecessor === sessionID)
  return next.length === 1 ? next[0] : undefined
}

export const pendingHandoffFor = (sessionID: string, pending: PendingHandoff[]) => {
  const matches = pending.filter((item) => item.predecessor === sessionID || item.successor === sessionID)
  return matches.length === 1 ? matches[0] : undefined
}

export const transferPins = (pins: string[], from: string, to: string, directory: string, targetDirectory = directory) => {
  const oldKey = JSON.stringify([directory, from])
  const newKey = JSON.stringify([targetDirectory, to])
  return [...new Set(pins.map((key) => key === oldKey ? newKey : key))]
}

// Pins are directory/session pairs. A receipt alone cannot move a pin across
// directories; wait for every identity in the global session index.
export const reconcilePins = (pins: string[], handoffs: Handoff[], owners: LaneOwner[], sessions: { id: string; directory: string }[]) =>
  [...new Set(pins.map((key) => {
    try {
      const identity: unknown = JSON.parse(key)
      if (!Array.isArray(identity) || identity.length !== 2 || !identity.every((value) => typeof value === "string")) return key
      const id = identity[1] as string
      const edge = successorFor(id, handoffs, owners)
      if (!edge) return key
      const chain = [id]
      while (chain.at(-1) !== edge.successor) chain.push(handoffNext(chain.at(-1)!, handoffs)!.successor)
      const identities = chain.map((id) => sessions.filter((session) => session.id === id))
      if (identities.some((matches) => matches.length !== 1)) return key
      return JSON.stringify([identities.at(-1)![0]!.directory, edge.successor])
    } catch {
      return key
    }
  }))]

/** Reconcile only identities read from the pinned session's own Work host. */
export const reconcileHostPins = (
  host: string,
  pins: string[],
  lineage: { byEditspace: Record<string, { edges: Handoff[]; owners: LaneOwner[] }>; editspaceOf: (directory: string) => string | undefined } | undefined,
  rows: { id: string; directory: string; host?: string }[],
) => {
  if (!lineage) return pins
  const own = rows.filter((row) => row.host === host)
  // Each pin follows only the lineage of the editspace that holds its directory.
  return [...new Set(pins.flatMap((key) => {
    const directory = (() => { try { const value: unknown = JSON.parse(key); return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined } catch { return undefined } })()
    const scope = directory === undefined ? undefined : lineage.byEditspace[lineage.editspaceOf(directory) ?? ""]
    return scope ? reconcilePins([key], scope.edges, scope.owners, own) : [key]
  }))]
}

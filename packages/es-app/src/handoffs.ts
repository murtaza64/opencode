export type Handoff = { lane: string; predecessor: string; successor: string }
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
    if (owners.find((owner) => owner.lane === lane)?.owner === current)
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

export const transferPins = (pins: string[], from: string, to: string, directory: string) => {
  const oldKey = JSON.stringify([directory, from])
  const newKey = JSON.stringify([directory, to])
  return [...new Set(pins.map((key) => key === oldKey ? newKey : key))]
}

/* Agent map projection over relations the app already observes. Edge types:
 * - owner: a lane's current owner from its lane record
 * - handoff: verified predecessor -> successor lineage for that lane
 * - subagent: a session's parentID in the global session index
 * Nothing is inferred from titles, timing or prose. */

export type AgentStatus = "pending" | "busy" | "failed" | "idle" | "unknown"
export type MapSession = { id: string; title: string; directory: string; updated?: number; parentID?: string }
export type SessionRef = { id: string; title: string; directory?: string; known: boolean; status: AgentStatus; subagents: SessionRef[] }
export type LaneNode = {
  key: string
  editspace: string
  lane: string
  owner: string
  ownerSession?: SessionRef
  laneStatus?: string
  report?: { text: string; at?: number }
  issue?: string
  // Oldest first, excluding the owner. Empty when no verified lineage exists.
  predecessors: SessionRef[]
  chainBroken: boolean
}
export type StandaloneNode = { key: string; project: string; session: SessionRef }
export type CloudNode = { key: string; editspace: string; lane: string; owner: string; status?: string; report?: string }
export type MapCluster = { project: string; lanes: LaneNode[]; standalone: StandaloneNode[]; cloud: CloudNode[]; hidden: number }

export type MapInput = {
  // Root sessions in the current Home scope.
  roots: readonly (MapSession & { project?: string })[]
  session: (id: string) => MapSession | undefined
  children: (id: string) => readonly string[]
  lanes: readonly { editspace: string; lane: string; owner: string; status?: string; activity?: string; activity_at?: string; activity_session?: string; issue?: string }[]
  handoffs: readonly { editspace: string; lane: string; predecessor: string; successor: string }[]
  cloud: readonly { editspace: string; lane: string; owner: string; status?: string; activity?: string }[]
  status: (id: string) => AgentStatus
  pinned: (id: string) => boolean
  fallbackProject: string
  filter: "active" | "all"
  now: number
}

const day = 86_400_000
export const sessionOwner = (owner: string) => /^(?:opencode:)?(ses_[\w-]+)$/.exec(owner)?.[1]

export const buildAgentMap = (input: MapInput): MapCluster[] => {
  const ref = (id: string, depth = 0): SessionRef => {
    const session = input.session(id)
    return {
      id,
      title: session?.title || id,
      directory: session?.directory,
      known: !!session,
      status: session ? input.status(id) : "unknown",
      // Bound recursion for malformed parent cycles.
      subagents: depth > 4 ? [] : input.children(id).map((child) => ref(child, depth + 1)),
    }
  }
  const active = (id: string | undefined) => {
    if (!id) return true
    const session = input.session(id)
    // Unknown identities stay visible rather than silently disappearing.
    if (!session) return true
    const status = input.status(id)
    const attention = (value: AgentStatus) => value === "busy" || value === "pending" || value === "failed"
    return input.pinned(id) || attention(status) || input.now - (session.updated ?? 0) < day ||
      input.children(id).some((child) => attention(input.status(child)))
  }
  const clusters = new Map<string, MapCluster>()
  const cluster = (project: string) => {
    const existing = clusters.get(project)
    if (existing) return existing
    const created: MapCluster = { project, lanes: [], standalone: [], cloud: [], hidden: 0 }
    clusters.set(project, created)
    return created
  }
  const placed = new Set<string>()
  const laneKeys = new Set<string>()
  for (const lane of input.lanes) {
    const key = JSON.stringify(["lane", lane.editspace, lane.lane])
    // Cloud owners are workflow identities, never local sessions; they render as cloud nodes.
    if (laneKeys.has(key) || !lane.owner || lane.owner.startsWith("wingman:")) continue
    laneKeys.add(key)
    const ownerID = sessionOwner(lane.owner)
    const chain = lineage(ownerID, input.handoffs.filter((edge) => edge.editspace === lane.editspace && edge.lane === lane.lane))
    if (ownerID) placed.add(ownerID)
    chain.ids.forEach((id) => placed.add(id))
    const target = cluster(lane.editspace)
    if (input.filter === "active" && !active(ownerID)) {
      target.hidden++
      continue
    }
    target.lanes.push({
      key,
      editspace: lane.editspace,
      lane: lane.lane,
      owner: lane.owner,
      ownerSession: ownerID ? ref(ownerID) : undefined,
      laneStatus: lane.status,
      // A lane report is advisory and belongs to the session that wrote it.
      report: lane.activity && (!lane.activity_session || sessionOwner(lane.activity_session) === ownerID)
        ? { text: lane.activity, at: lane.activity_at ? Date.parse(lane.activity_at) || undefined : undefined } : undefined,
      issue: lane.issue || undefined,
      predecessors: chain.ids.map((id) => ref(id)),
      chainBroken: chain.broken,
    })
  }
  for (const root of input.roots) {
    if (root.parentID || placed.has(root.id)) continue
    const target = cluster(root.project || input.fallbackProject)
    if (input.filter === "active" && !active(root.id)) {
      target.hidden++
      continue
    }
    target.standalone.push({ key: JSON.stringify(["session", root.id]), project: target.project, session: ref(root.id) })
  }
  const cloud = [...input.cloud, ...input.lanes
    .filter((lane) => lane.owner.startsWith("wingman:") && !input.cloud.some((item) => item.editspace === lane.editspace && item.lane === lane.lane))
    .map((lane) => ({ editspace: lane.editspace, lane: lane.lane, owner: lane.owner, status: undefined, activity: lane.activity }))]
  for (const item of cloud) {
    const target = cluster(item.editspace)
    // An unobserved cloud status stays visible as unknown.
    if (input.filter === "active" && item.status && item.status !== "processing" && item.status !== "waiting") {
      target.hidden++
      continue
    }
    target.cloud.push({ key: JSON.stringify(["cloud", item.editspace, item.lane, item.owner]), editspace: item.editspace, lane: item.lane, owner: item.owner, status: item.status, report: item.activity })
  }
  return [...clusters.values()].sort((a, b) => a.project.localeCompare(b.project))
}

// Walk verified predecessors back from the current owner. Ambiguous or cyclic
// lineage stops the walk and is reported instead of guessed.
const lineage = (owner: string | undefined, edges: readonly { predecessor: string; successor: string }[]) => {
  const ids: string[] = []
  if (!owner) return { ids, broken: false }
  const seen = new Set([owner])
  let current = owner
  while (true) {
    const prior = edges.filter((edge) => edge.successor === current)
    if (!prior.length) return { ids, broken: false }
    if (prior.length > 1 || seen.has(prior[0]!.predecessor)) return { ids, broken: true }
    current = prior[0]!.predecessor
    seen.add(current)
    ids.unshift(current)
  }
}

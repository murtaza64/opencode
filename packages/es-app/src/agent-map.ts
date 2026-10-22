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

/* Network projection for the map (approved Fleet "A · Project map"). Nodes are real agents. Tree edges are explicit records
 * only: a lane's delegation parent or first spawner (lane provenance) and a
 * session's subagent parentage. Directed edges are observed mail only. */

export type MapTone = "working" | "input" | "failed" | "quiet" | "unknown"
export type MapAgent = {
  key: string
  project: string
  name: string
  kind: "lane" | "session" | "subagent" | "cloud"
  runtime: "local" | "cloud"
  state: string
  tone: MapTone
  depth: number
  parent?: string
  // Mail parties name lanes; sessions are matched by session ID.
  lane?: string
  session?: SessionRef
  laneNode?: LaneNode
  cloud?: CloudNode
  origin?: LaneOrigin
}
// How the lane's agent got there. `from` is the map node of the delegating or
// spawning session; `earlier` marks a spawner that is now a past owner of `from`.
export type LaneOrigin = { kind: "delegated" | "spawned"; by: string; status?: string; from?: string; earlier?: boolean }
export type ProvenanceRecord = { editspace: string; lane: string; kind: "delegated" | "spawned"; by: string; status?: string }
export type TreeEdgeKind = "subagent" | "delegated" | "spawned"
export type MapMail = { id: string; editspace: string; from: string; to: string; at: number; kind?: string; text: string }
export type MailEdge = { key: string; from: string; to: string; messages: MapMail[]; path: string }
export type PlacedAgent = MapAgent & { x: number; y: number }
export type ClusterBox = { project: string; cloud: boolean; x: number; y: number; width: number; height: number; count: number; divider?: number }
export type TreeEdge = { key: string; kind: TreeEdgeKind; path: string; cross?: boolean; earlier?: boolean }
export type MapLayout = { width: number; height: number; agents: PlacedAgent[]; clusters: ClusterBox[]; hierarchy: TreeEdge[] }

export const NODE = { width: 180, height: 62 }
const SIBLING_GAP = 24
const LEVEL_GAP = 72
const ROW_GAP = 56
const PAD = 22
const TITLE = 34
const CLUSTER_GAP = 16
const MAX_ROW = 4 * NODE.width + 3 * SIBLING_GAP

const tone = (status: AgentStatus): MapTone => status === "busy" ? "working" : status === "pending" ? "input" : status === "failed" ? "failed" : status === "idle" ? "quiet" : "unknown"
const stateWord = (status: AgentStatus) => status === "busy" ? "working" : status === "pending" ? "needs input" : status
const cloudTone = (status?: string): MapTone => status === "processing" ? "working" : status === "waiting" ? "input" : status ? "quiet" : "unknown"

export const flattenAgents = (clusters: readonly MapCluster[]): MapAgent[] => clusters.flatMap((cluster) => {
  const subagents = (session: SessionRef | undefined, parent: string, depth: number): MapAgent[] => session?.subagents.flatMap((child) => {
    const key = JSON.stringify(["session", child.id])
    return [{ key, project: cluster.project, name: child.title, kind: "subagent" as const, runtime: "local" as const, state: stateWord(child.status), tone: tone(child.status), depth, parent, session: child }, ...subagents(child, key, depth + 1)]
  }) ?? []
  return [
    ...cluster.lanes.flatMap((node) => [{
      key: node.key, project: cluster.project, name: node.lane, kind: "lane" as const, runtime: "local" as const,
      state: node.ownerSession ? stateWord(node.ownerSession.status) : "unknown", tone: node.ownerSession ? tone(node.ownerSession.status) : "unknown" as MapTone,
      depth: 0, lane: node.lane, session: node.ownerSession, laneNode: node,
    }, ...subagents(node.ownerSession, node.key, 1)]),
    ...cluster.standalone.flatMap((node) => [{
      key: node.key, project: cluster.project, name: node.session.title, kind: "session" as const, runtime: "local" as const,
      state: stateWord(node.session.status), tone: tone(node.session.status), depth: 0, session: node.session,
    }, ...subagents(node.session, node.key, 1)]),
    ...cluster.cloud.map((node) => ({
      key: node.key, project: cluster.project, name: node.lane, kind: "cloud" as const, runtime: "cloud" as const,
      state: node.status ?? "unknown", tone: cloudTone(node.status), depth: 0, lane: node.lane, cloud: node,
    })),
  ]
})

// Resolve a mail party to a map node: a lane in the same project or a session
// ID. Anything else is off this map and is not drawn. Nothing is guessed from prose.
export const mailParty = (agents: readonly MapAgent[], editspace: string, name: string) =>
  agents.find((agent) => agent.project === editspace && agent.lane === name)?.key ??
  agents.find((agent) => agent.session?.id === name)?.key

// Attach explicit provenance to lane nodes. A delegation (current parent)
// wins over a first-spawn record. The lane nests under its origin when both
// sit in the same region and no cycle forms; otherwise the edge is drawn
// across regions. Unresolvable origins (a human, an unloaded session) stay
// in the detail rail without an edge.
export const linkOrigins = (agents: readonly MapAgent[], records: readonly ProvenanceRecord[]): MapAgent[] => {
  const node = (by: string) => {
    const owner = agents.find((agent) => agent.kind !== "subagent" && agent.session?.id === by)
    if (owner) return { key: owner.key, earlier: false }
    const past = agents.find((agent) => agent.laneNode?.predecessors.some((session) => session.id === by))
    return past ? { key: past.key, earlier: true } : undefined
  }
  const origins = new Map<string, LaneOrigin>()
  for (const record of records.toSorted((a, b) => (a.kind === b.kind ? 0 : a.kind === "delegated" ? -1 : 1))) {
    const lane = agents.find((agent) => agent.kind === "lane" && agent.project === record.editspace && agent.lane === record.lane)
    if (!lane || origins.has(lane.key)) continue
    const from = node(record.by)
    origins.set(lane.key, { kind: record.kind, by: record.by, status: record.status, from: from && from.key !== lane.key ? from.key : undefined, earlier: from?.earlier })
  }
  const byKey = new Map(agents.map((agent) => [agent.key, agent]))
  const parents = new Map(agents.flatMap((agent) => agent.parent ? [[agent.key, agent.parent] as const] : []))
  const reaches = (start: string, target: string) => {
    const seen = new Set<string>()
    for (let current: string | undefined = start; current && !seen.has(current); current = parents.get(current)) {
      if (current === target) return true
      seen.add(current)
    }
    return false
  }
  return agents.map((agent) => {
    const origin = origins.get(agent.key)
    if (!origin) return agent
    const from = origin.from ? byKey.get(origin.from) : undefined
    const nest = from && from.project === agent.project && from.runtime === agent.runtime && !reaches(from.key, agent.key)
    if (nest) parents.set(agent.key, from.key)
    return { ...agent, origin, parent: nest ? from.key : agent.parent }
  })
}

// Each project is a region (cloud agents get their own region). Org roots
// (lanes, cloud agents, sessions that started lanes) come first with their
// descendants beneath; sessions not owning a lane follow below a divider.
// Regions sit side by side and wrap at `maxWidth` (the panel width at 100%).
type Tree = { agent: MapAgent; children: Tree[]; width: number; height: number }
export const layoutMap = (agents: readonly MapAgent[], maxWidth = 1500): MapLayout => {
  const groupOf = (agent: MapAgent) => JSON.stringify([agent.project, agent.runtime === "cloud"])
  const groups = [...new Set(agents.map(groupOf))]
  const placed: PlacedAgent[] = []
  const clusters: ClusterBox[] = []
  const hierarchy: TreeEdge[] = []
  let x = 10
  let y = 10
  let lineHeight = 0
  let width = 0
  for (const group of groups) {
    const [project, cloud] = JSON.parse(group) as [string, boolean]
    const members = agents.filter((agent) => groupOf(agent) === group)
    const trees = forest(members)
    // Lanes, cloud agents and sessions that started lanes form the org row;
    // sessions with only subagents sit below the divider.
    const startsLanes = (tree: Tree): boolean => tree.children.some((child) => child.agent.kind !== "subagent" || startsLanes(child))
    const owned = trees.filter((tree) => tree.agent.kind !== "session" || startsLanes(tree))
    const rowWidth = (row: Tree[]) => row.reduce((sum, tree) => sum + tree.width, 0) + Math.max(0, row.length - 1) * SIBLING_GAP
    // Rows wrap at about four nodes (or the panel) so regions stay side by side;
    // a subtree always stays whole under its root.
    const limit = Math.max(...trees.map((tree) => tree.width), Math.min(MAX_ROW, maxWidth - 20 - PAD * 2))
    const pack = (items: Tree[]) => items.reduce<Tree[][]>((all, tree) => {
      const row = all.at(-1)
      if (row && rowWidth([...row, tree]) <= limit) row.push(tree)
      else all.push([tree])
      return all
    }, [])
    // Widest trees first, so a large org tree is not pushed below a lone lane.
    const orgRows = pack(owned.toSorted((a, b) => b.width - a.width))
    const unattached = pack(trees.filter((tree) => !owned.includes(tree)))
    const rows = [...orgRows, ...unattached]
    const rowHeights = rows.map((row) => Math.max(...row.map((tree) => tree.height)))
    const boxWidth = PAD * 2 + Math.max(...rows.map(rowWidth))
    const boxHeight = PAD * 2 + rowHeights.reduce((sum, value) => sum + value, 0) + (rows.length - 1) * ROW_GAP
    if (x > 10 && x + boxWidth > maxWidth) {
      x = 10
      y += lineHeight + CLUSTER_GAP
      lineHeight = 0
    }
    const divider = orgRows.length && unattached.length
      ? y + PAD + rowHeights.slice(0, orgRows.length).reduce((sum, value) => sum + value + ROW_GAP, 0) - ROW_GAP / 2
      : undefined
    clusters.push({ project, cloud, x, y, width: boxWidth, height: boxHeight, count: members.length, divider })
    let rowY = y + PAD
    rows.forEach((row, index) => {
      let treeX = x + PAD
      for (const tree of row) {
        place(tree, treeX, rowY, placed, hierarchy)
        treeX += tree.width + SIBLING_GAP
      }
      rowY += rowHeights[index]! + ROW_GAP
    })
    x += boxWidth + CLUSTER_GAP
    lineHeight = Math.max(lineHeight, boxHeight + TITLE)
    width = Math.max(width, x)
  }
  // Origins that could not nest (another region, or a cycle) cross regions as curves.
  const byKey = new Map(placed.map((agent) => [agent.key, agent]))
  for (const agent of placed) {
    const from = agent.origin?.from ? byKey.get(agent.origin.from) : undefined
    if (from && agent.parent !== from.key) hierarchy.push({ key: `${from.key}>${agent.key}`, kind: agent.origin!.kind, earlier: agent.origin!.earlier, path: curve(from, agent), cross: true })
  }
  return { width: Math.max(width, 400), height: y + lineHeight + 10, agents: placed, clusters, hierarchy }
}

// Parents may follow children in member order (a lane nested under a lane
// listed later), so build every tree before attaching.
const forest = (members: readonly MapAgent[]) => {
  const trees = new Map(members.map((agent) => [agent.key, { agent, children: [], width: NODE.width, height: NODE.height } as Tree]))
  const roots = [...trees.values()].filter((tree) => {
    const parent = tree.agent.parent ? trees.get(tree.agent.parent) : undefined
    parent?.children.push(tree)
    return !parent
  })
  const measure = (tree: Tree) => {
    tree.children.forEach(measure)
    if (!tree.children.length) return
    tree.width = Math.max(NODE.width, tree.children.reduce((sum, child) => sum + child.width, 0) + (tree.children.length - 1) * SIBLING_GAP)
    tree.height = NODE.height + LEVEL_GAP + Math.max(...tree.children.map((child) => child.height))
  }
  roots.forEach(measure)
  return roots
}

// A soft S-curve from parent to child keeps the tree organic rather than ruled.
const elbow = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`
}

const place = (tree: Tree, x: number, y: number, placed: PlacedAgent[], hierarchy: TreeEdge[]) => {
  const nodeX = x + (tree.width - NODE.width) / 2
  placed.push({ ...tree.agent, x: nodeX, y })
  const span = tree.children.reduce((sum, child) => sum + child.width, 0) + (tree.children.length - 1) * SIBLING_GAP
  let childX = x + (tree.width - span) / 2
  for (const child of tree.children) {
    const childY = y + NODE.height + LEVEL_GAP
    const childNodeX = childX + (child.width - NODE.width) / 2
    hierarchy.push({ key: `${tree.agent.key}>${child.agent.key}`, kind: child.agent.kind === "subagent" ? "subagent" : child.agent.origin?.kind ?? "subagent", earlier: child.agent.origin?.earlier, path: elbow(nodeX + NODE.width / 2, y + NODE.height, childNodeX + NODE.width / 2, childY) })
    place(child, childX, childY, placed, hierarchy)
    childX += child.width + SIBLING_GAP
  }
}

// One curved, directed edge per ordered pair; opposite directions bow apart.
export const mailEdges = (layout: MapLayout, mail: readonly MapMail[]): MailEdge[] => {
  const byKey = new Map(layout.agents.map((agent) => [agent.key, agent]))
  const edges = new Map<string, MailEdge>()
  for (const message of mail) {
    const from = mailParty(layout.agents, message.editspace, message.from)
    const to = mailParty(layout.agents, message.editspace, message.to)
    const a = from && byKey.get(from)
    const b = to && byKey.get(to)
    if (!a || !b || from === to) continue
    const key = JSON.stringify([from, to])
    const existing = edges.get(key)
    if (existing) {
      existing.messages.push(message)
      continue
    }
    edges.set(key, { key, from, to, messages: [message], path: curve(a, b) })
  }
  return [...edges.values()].map((edge) => ({ ...edge, messages: edge.messages.toSorted((a, b) => a.at - b.at) }))
}

const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const start = { x: a.x + NODE.width / 2, y: a.y + NODE.height / 2 }
  const end = { x: b.x + NODE.width / 2, y: b.y + NODE.height / 2 }
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy) || 1
  // Bow to the right of travel so A->B and B->A never overlap.
  const bow = Math.min(90, 24 + length * 0.18)
  const control = { x: (start.x + end.x) / 2 - (dy / length) * bow, y: (start.y + end.y) / 2 + (dx / length) * bow }
  const p0 = boundary(start, control)
  const p1 = boundary(end, control)
  return `M ${round(p0.x)} ${round(p0.y)} Q ${round(control.x)} ${round(control.y)} ${round(p1.x)} ${round(p1.y)}`
}

// Where the ray from a node centre toward `toward` leaves the node box.
const boundary = (center: { x: number; y: number }, toward: { x: number; y: number }) => {
  const dx = toward.x - center.x
  const dy = toward.y - center.y
  const scale = 1 / Math.max(Math.abs(dx) / (NODE.width / 2 + 3), Math.abs(dy) / (NODE.height / 2 + 3), 1e-9)
  return { x: center.x + dx * Math.min(1, scale), y: center.y + dy * Math.min(1, scale) }
}
const round = (value: number) => Math.round(value * 10) / 10

export type StateEvent = { key: string; agent: string; level: "major" | "minor"; text: string; at?: number }

// State boundaries come from observed agent state and lane reports, never from mail.
export const stateEvents = (agents: readonly MapAgent[]): StateEvent[] => agents.flatMap((agent): StateEvent[] => [
  ...(agent.tone === "failed" ? [{ key: `${agent.key}:failed`, agent: agent.key, level: "major" as const, text: "Turn failed" }] : []),
  ...(agent.tone === "input" ? [{ key: `${agent.key}:input`, agent: agent.key, level: "major" as const, text: agent.kind === "cloud" ? "Waiting" : "Needs input" }] : []),
  ...(agent.laneNode?.laneStatus && agent.laneNode.laneStatus !== "active" ? [{ key: `${agent.key}:lane`, agent: agent.key, level: "major" as const, text: `Lane ${agent.laneNode.laneStatus}` }] : []),
  ...(agent.laneNode?.report ? [{ key: `${agent.key}:report`, agent: agent.key, level: "minor" as const, text: agent.laneNode.report.text, at: agent.laneNode.report.at }] : []),
  ...(agent.cloud?.report ? [{ key: `${agent.key}:report`, agent: agent.key, level: "minor" as const, text: agent.cloud.report }] : []),
]).toSorted((a, b) => (a.level === b.level ? (b.at ?? 0) - (a.at ?? 0) : a.level === "major" ? -1 : 1))

import { expect, test } from "bun:test"
import { buildAgentMap, flattenAgents, layoutMap, linkOrigins, mailEdges, mailParty, NODE, stateEvents, SUBAGENT, type AgentStatus, type MapInput, type MapMail, type MapSession } from "./agent-map"

const now = 10 * 86_400_000
const sessions: MapSession[] = [
  { id: "ses_owner", title: "home-agents worker", directory: "/es/lanes/home", updated: now - 1000 },
  { id: "ses_old1", title: "first owner", directory: "/es/lanes/home", updated: now - 5 * 86_400_000 },
  { id: "ses_old2", title: "second owner", directory: "/es/lanes/home", updated: now - 3 * 86_400_000 },
  { id: "ses_child", title: "explore subagent", directory: "/es/lanes/home", updated: now - 500, parentID: "ses_owner" },
  { id: "ses_squadron", title: "Squadron V2 design", directory: "/Users/me/opencode", updated: now - 2000 },
  { id: "ses_stale", title: "Old standalone", directory: "/Users/me/opencode", updated: now - 4 * 86_400_000 },
]
const input = (overrides: Partial<MapInput> = {}): MapInput => ({
  roots: sessions.filter((session) => !session.parentID).map((session) => ({ ...session, project: session.directory.startsWith("/es") ? "opencode" : "squadron" })),
  session: (id) => sessions.find((session) => session.id === id),
  children: (id) => sessions.filter((session) => session.parentID === id).map((session) => session.id),
  lanes: [{ editspace: "opencode", lane: "home-agents", owner: "ses_owner", status: "active", activity: "wiring Home", activity_at: new Date(now - 60_000).toISOString(), activity_session: "ses_owner" }],
  handoffs: [
    { editspace: "opencode", lane: "home-agents", predecessor: "ses_old1", successor: "ses_old2" },
    { editspace: "opencode", lane: "home-agents", predecessor: "ses_old2", successor: "ses_owner" },
  ],
  cloud: [],
  status: (id): AgentStatus => (id === "ses_owner" ? "busy" : "idle"),
  pinned: () => false,
  fallbackProject: "unregistered",
  filter: "all",
  now,
  ...overrides,
})

test("lane shows its current owner, verified predecessors oldest first, and subagents", () => {
  const [opencode] = buildAgentMap(input())
  const lane = opencode!.lanes[0]!
  expect(lane.ownerSession).toMatchObject({ id: "ses_owner", known: true, status: "busy" })
  expect(lane.predecessors.map((session) => session.id)).toEqual(["ses_old1", "ses_old2"])
  expect(lane.chainBroken).toBe(false)
  expect(lane.ownerSession!.subagents.map((session) => session.id)).toEqual(["ses_child"])
  expect(lane.report).toEqual({ text: "wiring Home", at: now - 60_000 })
})

test("handoff predecessors are not repeated as standalone sessions", () => {
  const [opencode] = buildAgentMap(input())
  expect(opencode!.standalone).toEqual([])
})

test("standalone sessions outside any lane appear under their own project", () => {
  const squadron = buildAgentMap(input()).find((cluster) => cluster.project === "squadron")!
  expect(squadron.lanes).toEqual([])
  expect(squadron.standalone.map((node) => node.session.title)).toEqual(["Squadron V2 design", "Old standalone"])
})

test("active filter hides only idle unpinned agents older than a day and counts them", () => {
  const clusters = buildAgentMap(input({ filter: "active", pinned: (id) => id === "ses_squadron" }))
  const squadron = clusters.find((cluster) => cluster.project === "squadron")!
  expect(squadron.standalone.map((node) => node.session.id)).toEqual(["ses_squadron"])
  expect(squadron.hidden).toBe(1)
  expect(clusters.find((cluster) => cluster.project === "opencode")!.lanes).toHaveLength(1)
})

test("an owner missing from the session index stays visible as unknown", () => {
  const [opencode] = buildAgentMap(input({ filter: "active", lanes: [{ editspace: "opencode", lane: "remote", owner: "opencode:ses_elsewhere" }], handoffs: [] }))
  expect(opencode!.lanes[0]!.ownerSession).toMatchObject({ id: "ses_elsewhere", known: false, status: "unknown", title: "ses_elsewhere" })
})

test("ambiguous lineage stops at the ambiguity instead of guessing", () => {
  const [opencode] = buildAgentMap(input({ handoffs: [
    { editspace: "opencode", lane: "home-agents", predecessor: "ses_old1", successor: "ses_owner" },
    { editspace: "opencode", lane: "home-agents", predecessor: "ses_old2", successor: "ses_owner" },
  ] }))
  expect(opencode!.lanes[0]!.predecessors).toEqual([])
  expect(opencode!.lanes[0]!.chainBroken).toBe(true)
})

test("handoffs from another lane or project are not attached", () => {
  const [opencode] = buildAgentMap(input({ handoffs: [
    { editspace: "opencode", lane: "other-lane", predecessor: "ses_old1", successor: "ses_owner" },
    { editspace: "dotfiles", lane: "home-agents", predecessor: "ses_old2", successor: "ses_owner" },
  ] }))
  expect(opencode!.lanes[0]!.predecessors).toEqual([])
})

test("a lane report written by another session is not attributed to the owner", () => {
  const [opencode] = buildAgentMap(input({ lanes: [{ editspace: "opencode", lane: "home-agents", owner: "ses_owner", activity: "predecessor note", activity_session: "ses_old2" }] }))
  expect(opencode!.lanes[0]!.report).toBeUndefined()
})

test("cloud owners render as cloud nodes, never as local sessions", () => {
  const clusters = buildAgentMap(input({
    roots: [],
    lanes: [{ editspace: "opencode", lane: "cloud-review", owner: "wingman:task-1", activity: "reviewing" }],
    handoffs: [],
    cloud: [{ editspace: "opencode", lane: "cloud-done", owner: "wingman:task-2", status: "completed" }],
    filter: "active",
  }))
  const opencode = clusters.find((cluster) => cluster.project === "opencode")!
  expect(opencode.lanes).toEqual([])
  expect(opencode.cloud.map((node) => [node.lane, node.owner, node.status])).toEqual([["cloud-review", "wingman:task-1", undefined]])
  expect(opencode.hidden).toBe(1)
})

test("active filter keeps failed and attention-needing agents however old", () => {
  const squadron = buildAgentMap(input({ filter: "active", status: (id) => (id === "ses_stale" ? "failed" : "idle") })).find((cluster) => cluster.project === "squadron")!
  expect(squadron.standalone.map((node) => node.session.id)).toEqual(["ses_squadron", "ses_stale"])
})

const mail = (id: string, from: string, to: string, at: number): MapMail => ({ id, editspace: "opencode", from, to, at, kind: "notice", text: id })

test("network nodes are real agents with subagents under their parent, never synthetic coordinators", () => {
  const agents = flattenAgents(buildAgentMap(input()))
  expect(agents.map((agent) => [agent.kind, agent.name, agent.depth])).toEqual([
    ["lane", "home-agents", 0],
    ["subagent", "explore subagent", 1],
    ["session", "Squadron V2 design", 0],
    ["session", "Old standalone", 0],
  ])
  expect(agents[0]).toMatchObject({ state: "working", tone: "working", runtime: "local" })
  expect(agents[1]!.parent).toBe(agents[0]!.key)
})

test("each project is a region: lane owners on top with smaller subagent pills centred beneath", () => {
  const layout = layoutMap(flattenAgents(buildAgentMap(input())))
  expect(layout.clusters.map((cluster) => [cluster.project, cluster.cloud, cluster.count])).toEqual([["opencode", false, 2], ["squadron", false, 2]])
  for (const agent of layout.agents) {
    const box = layout.clusters.find((cluster) => cluster.project === agent.project)!
    expect(agent.x).toBeGreaterThanOrEqual(box.x)
    expect(agent.x + agent.width).toBeLessThanOrEqual(box.x + box.width)
    expect(agent.y + agent.height).toBeLessThanOrEqual(box.y + box.height)
  }
  const [lane, child] = layout.agents
  expect(child!.y).toBeGreaterThan(lane!.y)
  expect([lane!.width, lane!.height, child!.width, child!.height]).toEqual([NODE.width, NODE.height, SUBAGENT.width, SUBAGENT.height])
  expect(child!.x + child!.width / 2).toBe(lane!.x + lane!.width / 2)
  expect(layout.hierarchy[0]!.path).toContain(" C ")
  expect(layout.hierarchy).toHaveLength(1)
  // No lane owners in squadron: a single unattached row, so no divider.
  expect(layout.clusters[1]!.divider).toBeUndefined()
})

test("unattached sessions sit below the lane owner row and its subagent trees", () => {
  const layout = layoutMap(flattenAgents(buildAgentMap(input({ roots: [...input().roots, { ...sessions[4]!, project: "opencode" }] }))))
  const opencode = layout.clusters.find((cluster) => cluster.project === "opencode")!
  const child = layout.agents.find((agent) => agent.name === "explore subagent")!
  const loose = layout.agents.find((agent) => agent.name === "Squadron V2 design")!
  expect(opencode.divider).toBeGreaterThan(child.y + child.height)
  expect(loose.y).toBeGreaterThan(opencode.divider!)
})

test("cloud agents get their own region", () => {
  const layout = layoutMap(flattenAgents(buildAgentMap(input({ cloud: [{ editspace: "opencode", lane: "review", owner: "wingman:x", status: "processing" }] }))))
  expect(layout.clusters.map((cluster) => [cluster.project, cluster.cloud, cluster.count])).toEqual([["opencode", false, 2], ["opencode", true, 1], ["squadron", false, 2]])
})

test("observed mail becomes one directed edge per ordered pair; off-map counterparts are not drawn", () => {
  const agents = flattenAgents(buildAgentMap(input({ lanes: [...input().lanes, { editspace: "opencode", lane: "orchestrator", owner: "ses_squadron" }] })))
  const messages = [mail("m1", "orchestrator", "home-agents", 1), mail("m2", "home-agents", "orchestrator", 2), mail("m3", "orchestrator", "home-agents", 3), mail("m4", "home-agents", "project", 4)]
  expect(mailParty(agents, "opencode", "project")).toBeUndefined()
  const edges = mailEdges(layoutMap(agents), messages)
  expect(edges.map((edge) => [JSON.parse(edge.from)[2], JSON.parse(edge.to)[2], edge.messages.map((message) => message.id)])).toEqual([
    ["orchestrator", "home-agents", ["m1", "m3"]],
    ["home-agents", "orchestrator", ["m2"]],
  ])
  // Opposite directions bow to opposite sides instead of overlapping.
  expect(edges[0]!.path).not.toBe(edges[1]!.path)
})

test("mail parties resolve only to lanes in the same project", () => {
  const agents = flattenAgents(buildAgentMap(input()))
  expect(mailParty(agents, "other", "home-agents")).toBeUndefined()
  expect(mailParty(agents, "opencode", "home-agents")).toBe(agents[0]!.key)
})

test("state boundaries come from agent state and lane reports, major first", () => {
  const agents = flattenAgents(buildAgentMap(input({ status: (id) => id === "ses_owner" ? "pending" : id === "ses_squadron" ? "failed" : "idle" })))
  expect(stateEvents(agents).map((event) => [event.level, event.text])).toEqual([
    ["major", "Needs input"],
    ["major", "Turn failed"],
    ["minor", "wiring Home"],
  ])
})

const org = () => input({
  roots: [...input().roots, { id: "ses_lead", title: "orchestrator session", directory: "/es/lanes/orch", updated: now - 100, project: "opencode" }],
  session: (id) => id === "ses_lead" ? { id, title: "orchestrator session", directory: "/es/lanes/orch", updated: now - 100 } : sessions.find((session) => session.id === id),
  lanes: [
    ...input().lanes,
    { editspace: "opencode", lane: "orchestrator", owner: "ses_lead" },
    { editspace: "opencode", lane: "worker", owner: "ses_squadron" },
  ],
})

test("a delegation nests the lane under its current delegator; delegation wins over a spawn record", () => {
  const agents = linkOrigins(flattenAgents(buildAgentMap(org())), [
    { editspace: "opencode", lane: "home-agents", kind: "spawned", by: "ses_somebody" },
    { editspace: "opencode", lane: "home-agents", kind: "delegated", by: "ses_lead", status: "submitted" },
  ])
  const lane = agents.find((agent) => agent.lane === "home-agents")!
  const lead = agents.find((agent) => agent.lane === "orchestrator")!
  expect(lane.origin).toEqual({ kind: "delegated", by: "ses_lead", status: "submitted", from: lead.key, earlier: false })
  expect(lane.parent).toBe(lead.key)
  const layout = layoutMap(agents)
  const placedLane = layout.agents.find((agent) => agent.key === lane.key)!
  const placedLead = layout.agents.find((agent) => agent.key === lead.key)!
  expect(placedLane.y).toBeGreaterThan(placedLead.y)
  expect(layout.hierarchy.find((edge) => edge.key === `${lead.key}>${lane.key}`)).toMatchObject({ kind: "delegated" })
})

test("a spawner that has since handed off resolves to its lane as an earlier owner", () => {
  const agents = linkOrigins(flattenAgents(buildAgentMap(org())), [{ editspace: "opencode", lane: "worker", kind: "spawned", by: "ses_old1" }])
  const worker = agents.find((agent) => agent.lane === "worker")!
  expect(worker.origin).toMatchObject({ kind: "spawned", from: JSON.stringify(["lane", "opencode", "home-agents"]), earlier: true })
})

test("a human or unloaded spawner is kept as provenance without an edge", () => {
  const agents = linkOrigins(flattenAgents(buildAgentMap(org())), [{ editspace: "opencode", lane: "worker", kind: "spawned", by: "me@laptop" }])
  const worker = agents.find((agent) => agent.lane === "worker")!
  expect(worker.origin).toEqual({ kind: "spawned", by: "me@laptop", status: undefined, from: undefined, earlier: undefined })
  expect(worker.parent).toBeUndefined()
  expect(layoutMap(agents).hierarchy.filter((edge) => edge.kind !== "subagent")).toEqual([])
})

test("cyclic provenance never nests; the closing edge crosses instead", () => {
  const agents = linkOrigins(flattenAgents(buildAgentMap(org())), [
    { editspace: "opencode", lane: "worker", kind: "spawned", by: "ses_lead" },
    { editspace: "opencode", lane: "orchestrator", kind: "spawned", by: "ses_squadron" },
  ])
  const layout = layoutMap(agents)
  expect(layout.agents).toHaveLength(agents.length)
  expect(layout.hierarchy.filter((edge) => edge.kind === "spawned").map((edge) => !!edge.cross).toSorted()).toEqual([false, true])
})

test("provenance for another project's lane name does not attach", () => {
  const agents = linkOrigins(flattenAgents(buildAgentMap(org())), [{ editspace: "squadron", lane: "worker", kind: "spawned", by: "ses_lead" }])
  expect(agents.some((agent) => agent.origin)).toBe(false)
})

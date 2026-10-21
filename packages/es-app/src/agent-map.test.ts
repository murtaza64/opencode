import { expect, test } from "bun:test"
import { buildAgentMap, type AgentStatus, type MapInput, type MapSession } from "./agent-map"

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

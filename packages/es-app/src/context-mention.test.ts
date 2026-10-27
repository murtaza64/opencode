import { expect, test } from "bun:test"
import { CONTEXT_MENTION_SOURCE, contextGroups, contextKey, contextPart, insertContextLabel, type ContextRef } from "./context-mention"

const sessions = [
  { id: "ses_self", title: "Relay worker", directory: "/w/self", updated: 9 },
  { id: "ses_old", title: "Relay before handoff", directory: "/w/old", updated: 1 },
  { id: "ses_new", title: "Relay notes", directory: "/w/new", updated: 5, live: "busy" },
  { id: "ses_gone", title: "Relay archived", directory: "/w/gone", updated: 7, archived: 1 },
  { id: "ses_other", title: "Unrelated", directory: "/w/relay-dir", updated: 8 },
]
const agents = [
  { editspace: "es", lane: "orchestrator", owner: "ses_new", activity: "routing relay work", live: "busy" },
  { editspace: "es", lane: "relay-ui", owner: "ses_x" },
  { editspace: "es", lane: "mine", owner: "ses_self" },
]
const groups = (query: string, added: ContextRef[] = []) =>
  contextGroups({ query, host: "laptop:4096", agents, sessions, currentID: "ses_self", laneOf: (id) => id === "ses_new" ? "orchestrator" : undefined, added })

test("groups agents before sessions, ranks label prefix first, and excludes this session, its own lane and archived rows", () => {
  const result = groups("relay")
  expect(result.map((group) => group.name)).toEqual(["Agents", "Sessions"])
  expect(result[0]!.items.map((item) => item.id)).toEqual(["es/relay-ui", "es/orchestrator"])
  expect(result[1]!.items.map((item) => item.id)).toEqual(["ses_new", "ses_old", "ses_other"])
  expect(result[1]!.items[0]).toMatchObject({ host: "laptop:4096", lane: "orchestrator", label: "Relay notes" })
})

test("omits empty groups and items already attached", () => {
  const [agent] = groups("orch")[0]!.items
  expect(groups("orch", [agent!]).map((group) => group.name)).toEqual([])
  expect(groups("notes").map((group) => group.name)).toEqual(["Sessions"])
})

test("keys are typed and host-qualified", () => {
  expect(contextKey({ kind: "session", host: "mini:4096", id: "ses_a" })).toBe("session:mini:4096:ses_a")
})

test("inserts a readable label in place of the query, not the ID", () => {
  expect(insertContextLabel("ask @rel now", 4, 8, "Relay  notes")).toEqual({ text: "ask @Relay notes  now", caret: 17 })
})

test("a context part is synthetic, source-tagged and bounded, with a re-fetchable reference", () => {
  const ref: ContextRef = { kind: "agent", id: "es/orchestrator", host: "laptop:4096", label: "orchestrator", editspace: "es", lane: "orchestrator",
    owner: "ses_new", activity: "x".repeat(5000) }
  const part = contextPart(ref, "https://host/session/ses_new", Date.UTC(2026, 9, 27))
  expect(part).toMatchObject({ type: "text", synthetic: true, metadata: { source: CONTEXT_MENTION_SOURCE, key: "agent:laptop:4096:es/orchestrator" } })
  expect(part.text.length).toBeLessThan(2048)
  expect(part.text).toContain("not a request to contact anyone")
  expect(JSON.parse(part.text.split("Reference: ")[1]!)).toEqual({ kind: "agent", id: "es/orchestrator", host: "laptop:4096",
    asOf: "2026-10-27T00:00:00.000Z", url: "https://host/session/ses_new" })
})

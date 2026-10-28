import { expect, test } from "bun:test"
import { CONTEXT_MENTION_SOURCE, contextBound, contextGroups, contextKey, contextPart, insertContextLabel, type ContextRef } from "./context-mention"

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

const decision = (id: string, status: string, updated: number, extra: Record<string, unknown> = {}) => ({ id, editspace: "es", revision: 9, content_revision: 3,
  status, lane: "runtime-options", kind: "decision", title: `Ship relay ${id}?`, context: "Pick the release order.", updated_at: updated,
  options: [{ id: "a", label: "Ship now" }, { id: "b", label: "Wait" }], recommendation: "Ship now", ...extra }) as never
const surface = (id: string, updated: number, extra: Record<string, unknown> = {}) => ({ id, editspace: "es", title: `Relay ${id}`, summary: "Live board",
  owner: "ses_owner", lane: "relay-board", updated_at: updated, revision: 4, purpose: "board", health: { state: "ok" }, ...extra }) as never
const withCatalog = (query: string, decisions: never[], surfaces: never[], added: ContextRef[] = []) =>
  contextGroups({ query, host: "mini:4096", agents: [], sessions: [], currentID: "ses_self", laneOf: () => undefined, added, decisions, surfaces })

test("decisions and surfaces follow agents and sessions; only open or snoozed decisions, open and recent first", () => {
  const result = withCatalog("relay", [decision("old", "open", 1), decision("snz", "snoozed", 9), decision("new", "open", 5), decision("done", "answered", 10)],
    [surface("a", 1), surface("b", 2)])
  expect(result.map((group) => group.name)).toEqual(["Decisions", "Surfaces"])
  expect(result[0]!.items.map((item) => item.id)).toEqual(["new", "old", "snz"])
  expect(result[1]!.items.map((item) => item.id)).toEqual(["b", "a"])
})

test("a decision is captured at its content revision with question and options, not the answer state", () => {
  const [ref] = withCatalog("", [decision("d1", "open", 1)], [])[0]!.items
  expect(ref).toMatchObject({ kind: "decision", revision: 3, question: "Pick the release order.", options: ["Ship now", "Wait"], recommendation: "Ship now" })
  expect(contextBound(ref!)).toBe("Adds: question + options (rev 3), link. Does not answer or notify.")
  expect(withCatalog("", [decision("d1", "open", 1)], [], [ref!])).toEqual([])
})

test("a decision part carries question, options and an exact-revision reference without approving anything", () => {
  const [ref] = withCatalog("", [decision("d1", "open", 1)], [])[0]!.items
  const part = contextPart(ref!, "https://mini/?item=attention%3Aes%3Ad1", Date.UTC(2026, 9, 27))
  expect(part.text).toContain("Options: 1) Ship now; 2) Wait")
  expect(part.text).toContain("Question: Pick the release order.")
  expect(part.text).toContain("does not answer, approve or notify anyone")
  expect(JSON.parse(part.text.split("Reference: ")[1]!)).toEqual({ kind: "decision", id: "d1", host: "mini:4096", revision: 3,
    asOf: "2026-10-27T00:00:00.000Z", url: "https://mini/?item=attention%3Aes%3Ad1" })
})

test("a surface part is metadata only and says its content is not included", () => {
  const [ref] = withCatalog("", [], [surface("board", 1, { health: { state: "unreachable" } })])[0]!.items
  expect(contextBound(ref!)).toBe("Adds: title + summary (rev 4), link. Not the surface content.")
  const part = contextPart(ref!, "https://mini/?surface=board", 0)
  expect(part.text).toContain("Summary: Live board")
  expect(part.text).toContain("Content: not included")
  expect(part.metadata.key).toBe("surface:mini:4096:board")
})

test("a long multi-byte snapshot stays within 2 KB of UTF-8 and keeps its reference", () => {
  const [ref] = withCatalog("", [decision("d1", "open", 1, { context: "é界".repeat(3000), options: Array.from({ length: 20 }, (_, index) => ({ id: `${index}`, label: "選".repeat(500) })) })], [])[0]!.items
  const part = contextPart(ref!, "https://mini/?item=x", 0)
  expect(new TextEncoder().encode(part.text).length).toBeLessThanOrEqual(2048)
  expect(JSON.parse(part.text.split("Reference: ")[1]!)).toMatchObject({ kind: "decision", id: "d1", revision: 3 })
})

test("a session with an unknown update time still produces its part", () => {
  const ref: ContextRef = { kind: "session", id: "ses_x", host: "mini:4096", label: "X", directory: "/w", updated: Number.NaN }
  expect(contextPart(ref, "https://mini/session/ses_x", 0).text).toContain("Last updated: unknown")
})

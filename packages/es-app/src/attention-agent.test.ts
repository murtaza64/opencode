import { expect, test } from "bun:test"
import type { AttentionRecord } from "./attention"
import { requestAgent, type AgentSources } from "./attention-agent"

const record = (overrides: Partial<AttentionRecord> = {}) => ({
  id: "att_1", editspace: "workbench-upgrade", revision: 1, status: "open", lane: "batch-orchestrator", kind: "decision",
  title: "Pick a worker", context: "", options: [], producer_session: "ses_joiner", origin_session: "ses_joiner",
  gate_key: "gate", source_ref: { session_id: "ses_joiner", directory: "/es/lanes/batch-orchestrator" },
  decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1, ...overrides,
}) as AttentionRecord

const sessions: Record<string, { title?: string; directory?: string }> = {
  ses_joiner: { title: "Joiner", directory: "/es/lanes/batch-orchestrator" },
  ses_tether: { title: "Tether", directory: "/es/lanes/squadron-v2" },
  ses_next: { title: "Joiner (2)", directory: "/es/lanes/batch-orchestrator" },
  ses_untitled: { title: "New session - 2026-10-22T10:00:00.000Z" },
  ses_brief: { title: "Front desk brief" },
}
const lane = (name: string) => JSON.stringify(["workbench-upgrade", name])
const sources = (overrides: Partial<AgentSources> = {}): AgentSources => ({
  session: (id) => sessions[id],
  handoffs: [],
  owners: [{ lane: lane("batch-orchestrator"), owner: "ses_joiner" }, { lane: lane("squadron-v2"), owner: "ses_tether" }],
  ...overrides,
})

test("names the requesting agent by its session title and links its own directory", () => {
  expect(requestAgent(record(), sources())).toEqual({ session: "ses_joiner", label: "Joiner", named: true,
    directory: "/es/lanes/batch-orchestrator", lane: "batch-orchestrator" })
})

test("agents sharing one project are told apart by their own sessions", () => {
  const tether = record({ id: "att_2", lane: "squadron-v2", origin_session: "ses_tether", producer_session: "ses_tether",
    source_ref: { session_id: "ses_tether", directory: "/es/lanes/squadron-v2" } })
  expect([requestAgent(record(), sources()).label, requestAgent(tether, sources()).label]).toEqual(["Joiner", "Tether"])
})

test("an unknown or untitled requester falls back to its lane, then to an explicit unknown", () => {
  expect(requestAgent(record({ origin_session: "ses_gone", producer_session: "ses_gone" }), sources())).toMatchObject({
    session: "ses_gone", label: "batch-orchestrator", named: false })
  expect(requestAgent(record({ origin_session: "ses_untitled", producer_session: "ses_untitled" }), sources()).label).toBe("batch-orchestrator")
  expect(requestAgent(record({ lane: null, origin_session: "ses_gone", producer_session: "ses_gone" }), sources())).toMatchObject({
    label: "Unknown agent", named: false })
})

test("a handed-off requester stays the requester; the verified successor is where answers now go", () => {
  const handoffs = [{ lane: lane("batch-orchestrator"), predecessor: "ses_joiner", successor: "ses_next" }]
  const owners = [{ lane: lane("batch-orchestrator"), owner: "ses_next" }]
  const agent = requestAgent(record(), sources({ handoffs, owners }))
  expect(agent.label).toBe("Joiner")
  expect(agent.destination).toEqual({ session: "ses_next", label: "Joiner (2)", named: true, directory: "/es/lanes/batch-orchestrator" })
  // Lineage that does not reach the current owner is not trusted.
  expect(requestAgent(record(), sources({ handoffs, owners: [{ lane: lane("batch-orchestrator"), owner: "ses_other" }] })).destination).toBeUndefined()
  // A matching chain in another editspace's lane is not this record's lane.
  const elsewhere = [{ lane: JSON.stringify(["other", "batch-orchestrator"]), predecessor: "ses_joiner", successor: "ses_next" }]
  expect(requestAgent(record(), sources({ handoffs: elsewhere, owners: [{ lane: elsewhere[0]!.lane, owner: "ses_next" }] })).destination).toBeUndefined()
})

test("a later content author is listed separately and never replaces the requester", () => {
  const agent = requestAgent(record({ producer_session: "ses_brief" }), sources())
  expect(agent.label).toBe("Joiner")
  expect(agent.author).toMatchObject({ session: "ses_brief", label: "Front desk brief" })
})

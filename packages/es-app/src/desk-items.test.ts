import { expect, test } from "bun:test"
import type { MessageWithParts } from "./api"
import type { AttentionRecord } from "./attention"
import { attentionItem, BRIEF_SCHEMA, BRIEF_SYSTEM, briefItems, briefPacket, briefState, type BriefMeta } from "./desk"

// A synthetic compound request: seven numbered decisions, each with a recommendation and (except D5) one alternative.
const ROWS = [
  ["D1", "Which modifier do app chords use on Linux?", "Alt", "Ctrl"],
  ["D2", "Which key returns to the last session?", "Mod+`", "Ctrl+6"],
  ["D3", "Which key opens the command palette?", "Mod+K", "Mod+P"],
  ["D4", "Does Linux also accept Ctrl+M to cycle modes?", "also accept Ctrl+M", "Super+M only"],
  ["D5", "Does jk leave insert mode?", "yes, within 200 ms", ""],
  ["D6", "Do Ctrl+H/E/N/P/D/U edit text while typing?", "restore text editing except Ctrl+E", "keep app keys"],
  ["D7", "What does Tab do in insert mode?", "keep session switch plus F6", "normal mode only"],
] as const
const context = ["Seven keyboard decisions; recommendations first.",
  ...ROWS.map(([id, question, recommended, alternative]) => `${id}. ${question} Recommended: ${recommended}.${alternative ? ` Alternative: ${alternative}.` : ""}`)].join("\n")
const record: AttentionRecord = {
  id: "att_keys", editspace: "alpha", revision: 1, status: "open", kind: "decision", title: "Approve the seven keyboard decisions?", context,
  options: [{ id: "accept", label: "Accept all recommendations" }, { id: "change", label: "Change some", input: { kind: "text", label: "Changes", required: true } }],
  recommendation: "accept", producer_session: "ses_p", origin_session: "ses_p", gate_key: "keys", source_ref: { session_id: "ses_src", directory: "/alpha" },
  decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1,
}
const item = attentionItem(record, 0)
const reply = (value: unknown) => {
  const packet = briefPacket(item, [])
  const meta: BriefMeta = { kind: "brief", requestID: "r", source: item.key, revision: item.revision, title: record.title, refs: packet.refs, contract: 4 }
  const messages = [{ info: { id: "msg_u", role: "user" }, parts: [{ type: "text", text: packet.text }] },
    { info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: JSON.stringify(value) }] }] as unknown as MessageWithParts[]
  const state = briefState(meta, messages, "idle")
  if (state.state !== "ready") throw Error(`not ready: ${JSON.stringify(state)}`)
  return state.result
}
// The model's rows as a faithful reply would give them.
const modelRows = ROWS.map(([id, question, recommended, alternative]) => ({ id, question, recommended, alternatives: alternative ? [alternative] : [], refs: ["C1"] }))

test("the prompt asks for every item as its own row, and the schema carries them", () => {
  expect(BRIEF_SYSTEM).toContain("Never merge, group by theme, renumber, drop or reorder items")
  expect(BRIEF_SYSTEM).toContain("Shapes compare the options, never the items.")
  expect((BRIEF_SCHEMA.properties as Record<string, { maxItems?: number }>).items?.maxItems).toBe(20)
})

test("seven numbered items survive the round trip with their ids, count, order and values", () => {
  const rows = briefItems(reply({ question: "Approve the seven keyboard decisions?", choices: [], items: modelRows }), item)
  expect(rows.map(row => row.id)).toEqual(["D1", "D2", "D3", "D4", "D5", "D6", "D7"])
  expect(rows.map(row => [row.question, row.recommended, row.alternatives])).toEqual(ROWS.map(([, question, recommended, alternative]) => [question, recommended, alternative ? [alternative] : []]))
  // D5 names no alternative, so it shows none.
  expect(rows[4]!.alternatives).toEqual([])
})

test("a value not quoted from the request is blanked, and an id the request never uses is dropped", () => {
  const changed = modelRows.map(row => row.id === "D3" ? { ...row, recommended: "Mod+P (approved)" } : row)
  const rows = briefItems(reply({ question: "Q?", choices: [], items: [...changed, { id: "D8", question: "Invented?", recommended: "", alternatives: [], refs: [] }] }), item)
  expect(rows.map(row => row.id)).toEqual(["D1", "D2", "D3", "D4", "D5", "D6", "D7"])
  expect(rows[2]!.recommended).toBe("")
  expect(rows[2]!.alternatives).toEqual(["Mod+P"])
})

test("a repeated id keeps its first row only, and briefs without items parse with none", () => {
  const rows = briefItems(reply({ question: "Q?", choices: [], items: [modelRows[0], modelRows[0], modelRows[1]] }), item)
  expect(rows.map(row => row.id)).toEqual(["D1", "D2"])
  expect(reply({ question: "Q?", choices: [] }).items).toEqual([])
})

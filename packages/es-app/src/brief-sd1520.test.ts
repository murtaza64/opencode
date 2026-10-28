import { expect, test } from "bun:test"
import type { MessageWithParts } from "./api"
import type { AttentionRecord } from "./attention"
import { briefApproval } from "./brief-approval"
import { attentionItem, briefItems, briefPacket, briefState, type BriefMeta } from "./desk"
import fixture from "./fixtures/attention-sd1520.json"

// Shape of the first genuine compound ask (SD-1520): six "D# · question · recommended · alternatives" lines and the same three options; wording is generic.
const record = fixture as AttentionRecord
const lines = record.context.split("\n").filter(line => /^D\d · /.test(line))
// A faithful contract-4 reply: each item quoted from the request, in order.
const rows = lines.map(line => {
  const [id, question, rest] = line.split(" · ")
  const [recommended, alternatives] = rest.replace("recommended: ", "").split(" · alternatives: ")
  return { id, question, recommended, alternatives: alternatives ? alternatives.split("; ").slice(0, 4) : [], refs: ["C1"] }
})
const parse = (item: ReturnType<typeof attentionItem>) => {
  const packet = briefPacket(item, [])
  const meta: BriefMeta = { kind: "brief", requestID: "r", source: item.key, revision: item.revision, title: record.title, refs: packet.refs, contract: 4 }
  const messages = [{ info: { id: "msg_u", role: "user" }, parts: [{ type: "text", text: packet.text }] },
    { info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: JSON.stringify({ question: record.title, choices: [], items: rows }) }] }] as unknown as MessageWithParts[]
  const state = briefState(meta, messages, "idle")
  if (state.state !== "ready") throw Error(`not ready: ${JSON.stringify(state)}`)
  return state.result
}

test("SD-1520 keeps six separate rows with their quoted values", () => {
  const item = attentionItem(record, 0)
  const parsed = briefItems(parse(item), item)
  expect(parsed.map(row => row.id)).toEqual(["D1", "D2", "D3", "D4", "D5", "D6"])
  expect(parsed.every(row => row.question !== "" && row.recommended !== "")).toBe(true)
})

test("SD-1520 'Approve recommendations D1-D6' approves no row individually; the answer shows once", () => {
  const item = attentionItem({ ...record, status: "answered", answer: { id: "a", choice_id: "approve-d1-d6", text: "", answered_at: 2, revision: 1 } }, 0)
  const approval = briefApproval(briefItems(parse(item), item), item, { id: "job", revision: item.revision })
  expect(approval.values).toEqual(Array(6).fill("Not individually recorded"))
  expect(approval.verbatim).toBe("Approve recommendations D1-D6")
})

test("SD-1520 'Approve with changes' marks only the item IDs the human named", () => {
  const item = attentionItem({ ...record, status: "answered", answer: { id: "a", choice_id: "approve-with-changes", input_value: "D2: park; D3: per item", text: "", answered_at: 2, revision: 1 } }, 0)
  const approval = briefApproval(briefItems(parse(item), item), item, { id: "job", revision: item.revision })
  expect(approval.values).toEqual(["Not individually recorded", "D2: park", "D3: per item", "Not individually recorded", "Not individually recorded", "Not individually recorded"])
})

import { expect, test } from "bun:test"
import { briefApproval } from "./brief-approval"
import { attentionItem, type BriefItem } from "./desk"
import type { AttentionRecord } from "./attention"

const rows: BriefItem[] = ["D1", "D2", "D3"].map(id => ({ id, question: id, recommended: "", alternatives: [], refs: [] }))
const record: AttentionRecord = {
  id: "keys", editspace: "fixture", revision: 5, content_revision: 2, status: "answered", kind: "decision",
  title: "Three keys", context: "D1 D2 D3", options: [{ id: "accept", label: "Accept all recommendations" }, { id: "D2-choice", label: "Choose D2" }],
  producer_session: "ses_a", origin_session: "ses_a", gate_key: "keys", source_ref: { session_id: "ses_a", directory: "/fixture" },
  recommendation: "accept", decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 2,
}
const job = { id: "brief-2", revision: "2" }
const answered = { id: "answer", choice_id: "accept", text: "", answered_at: 3, revision: 2, brief: { job: job.id, revision: job.revision } }

test("unanswered rows show no approval", () => {
  expect(briefApproval(rows, attentionItem(record, 0), job)).toEqual({ answered: false, values: ["", "", ""], verbatim: "" })
})

test("generic selected option never implies per-item approval; ledger answer appears once", () => {
  const item = attentionItem({ ...record, answer: answered }, 0)
  expect(briefApproval(rows, item, job)).toEqual({ answered: true, values: ["Not individually recorded", "Not individually recorded", "Not individually recorded"], verbatim: "Accept all recommendations" })
})

test("literal IDs in the chosen label or input identify only named rows", () => {
  const item = attentionItem({ ...record, answer: { ...answered, choice_id: "D2-choice", input_value: "D1: Alt" } }, 0)
  expect(briefApproval(rows, item, job)).toEqual({ answered: true, values: ["D1: Alt", "Choose D2", "Not individually recorded"], verbatim: "Choose D2 · D1: Alt" })
})

test("free text may name an item but substring matches and a different brief cannot", () => {
  const item = attentionItem({ ...record, answer: { ...answered, text: "D30: no; D3: yes" } }, 0)
  expect(briefApproval(rows, item, job).values).toEqual(["Not individually recorded", "Not individually recorded", "D3: yes"])
  expect(briefApproval(rows, item, { id: "new-brief", revision: "2" }).answered).toBe(false)
  expect(briefApproval(rows, attentionItem({ ...record, answer: { ...answered, brief: { job: job.id, revision: "1" } } }, 0), job).answered).toBe(false)
})

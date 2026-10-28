import { expect, test } from "bun:test"
import type { AttentionRecord } from "./attention"
import { deskItems } from "./desk"

const base = { editspace: "alpha", revision: 1, kind: "decision", context: "c", options: [{ id: "a", label: "A" }], recommendation: "a",
  producer_session: "ses_p", origin_session: "ses_p", gate_key: "g", source_ref: { session_id: "ses_p", directory: "/alpha" },
  decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1 } as const
const member = (index: number, status: AttentionRecord["status"], extra: Partial<AttentionRecord> = {}): AttentionRecord =>
  ({ ...base, id: `att_${index}`, title: `Question ${index}`, status, series: { id: "grill-1", index, title: "Grilling: keyboard plan" }, ...extra }) as AttentionRecord
const items = (records: AttentionRecord[]) => deskItems({ records, attentionChecked: 0, requests: [], failures: [], failuresChecked: 0, title: () => undefined, project: () => undefined })

test("seven questions of one series are one queue entry on the lowest-index open question", () => {
  const records = [member(3, "open"), member(1, "answered", { answer: { id: "ans_1", text: "", choice_id: "a", answered_at: 2 } }), member(2, "withdrawn"),
    member(5, "open"), member(6, "open"), member(7, "open"), member(9, "open")]
  const queue = items(records)
  expect(queue).toHaveLength(1)
  const [entry] = queue
  expect(entry!.key).toBe("series:alpha:ses_p:grill-1")
  expect(entry!.title).toBe("Grilling: keyboard plan")
  expect(entry!.record!.id).toBe("att_3")
  // Withdrawn members leave the denominator; the gap at 4 and 8 stays a gap; only a recorded answer counts.
  expect([entry!.series!.live, entry!.series!.answered]).toEqual([6, 1])
  expect(entry!.series!.members.map(record => record.series!.index)).toEqual([1, 2, 3, 5, 6, 7, 9])
})

test("a series with no open question leaves the queue, and records without a series are unchanged", () => {
  const plain = { ...member(1, "open"), id: "att_plain", series: undefined } as AttentionRecord
  const queue = items([member(1, "answered"), member(2, "withdrawn"), plain])
  expect(queue.map(entry => entry.key)).toEqual(["attention:alpha:att_plain"])
})

test("the same series id from another producer origin is a separate entry", () => {
  const queue = items([member(1, "open"), { ...member(1, "open"), id: "att_other", origin_session: "ses_q" } as AttentionRecord])
  expect(queue.map(entry => entry.key).toSorted()).toEqual(["series:alpha:ses_p:grill-1", "series:alpha:ses_q:grill-1"])
})

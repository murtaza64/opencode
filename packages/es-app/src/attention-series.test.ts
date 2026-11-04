import { expect, test } from "bun:test"
import type { AttentionRecord } from "./attention"
import { answerIsText, answerWords, deliveredState, grilling, hinge, seriesProgress } from "./attention-series"

const question = (index: number, status: AttentionRecord["status"], answer?: AttentionRecord["answer"]) =>
  ({ series: { id: "s", index }, title: `Question ${index}`, status, answer, recommendation: "yes" }) as AttentionRecord

test("orders by stable index, preserves gaps and excludes withdrawn from live progress", () => {
  const progress = seriesProgress([question(7, "open"), question(1, "answered", { id: "a", text: "", choice_id: "yes", answered_at: 1 }),
    question(5, "withdrawn"), question(3, "open"), question(9, "answered", { id: "b", text: "", choice_id: "no", answered_at: 2 })])
  expect(progress.ordered.map(record => record.series!.index)).toEqual([1, 3, 5, 7, 9])
  expect([progress.answered, progress.live]).toEqual([2, 4])
  expect(progress.unanswered.map(record => record.series!.index)).toEqual([3, 7])
  expect(progress.withdrawn.map(record => record.series!.index)).toEqual([5])
})

test("recommendation and status alone cannot count as a human answer", () => {
  const progress = seriesProgress([question(1, "answered"), question(2, "decided"), question(3, "open")])
  expect([progress.answered, progress.live]).toEqual([0, 3])
  expect(progress.unanswered.map(record => record.series!.index)).toEqual([1, 2, 3])
})

const member = (index: number, extra: Partial<AttentionRecord> = {}) => ({
  series: { id: "s", index }, title: `Question ${index}`, status: "open", answer: null, recommendation: "yes", created_at: 100, context: "",
  options: [{ id: "yes", label: "Yes, keep it" }, { id: "no", label: "No" }, { id: "other", label: "Other", input: { kind: "text", label: "Your proposal", required: true } }],
  delivery_state: "not-requested", ...extra,
}) as AttentionRecord
const said = (answered_at: number, fields: Partial<NonNullable<AttentionRecord["answer"]>>) => ({ id: `a${answered_at}`, text: "", choice_id: null, answered_at, ...fields })

test("grilling: follow-ups are questions published after the first answer; the because line needs caused_by", () => {
  const session = grilling([
    member(1, { status: "answered", answer: said(200, { choice_id: "other", input_value: "maybe the column it was rejected from?" }), delivery_state: "handled" }),
    member(2, { status: "answered", answer: said(210, { choice_id: "yes" }), delivery_state: "pending" }),
    member(3),
    member(5, { created_at: 300, caused_by: { index: 1 } }),
    member(6, { created_at: 300 }),
    member(4, { status: "withdrawn" }),
  ])
  expect(session.questions.map(question => [question.index, question.followUp])).toEqual([[1, false], [2, false], [3, false], [4, false], [5, true], [6, true]])
  expect(session.questions.find(question => question.index === 5)!.cause).toEqual({ index: 1, said: "maybe the column it was rejected from?" })
  expect(session.questions.find(question => question.index === 6)!.cause).toBeUndefined()
  expect([session.answered, session.live, session.followUps, session.next?.index]).toEqual([2, 5, 2, 3])
})

test("grilling: nothing is a follow-up before any answer, and next is empty once every live question is answered", () => {
  expect(grilling([member(1), member(2, { created_at: 999 })]).followUps).toBe(0)
  const done = grilling([member(1, { status: "answered", answer: said(1, { choice_id: "no" }) }), member(2, { status: "withdrawn" })])
  expect(done.next).toBeUndefined()
  // A snoozed question is unanswered but cannot be answered from the stepper, so it is not "next".
  expect(grilling([member(1, { status: "snoozed" }), member(2)]).next?.index).toBe(2)
})

test("answer words: written text first, then supplied input, then the chosen label", () => {
  expect(answerWords(member(1, { answer: said(1, { text: "nice to have, no rush", choice_id: null }) }))).toBe("nice to have, no rush")
  expect(answerWords(member(1, { answer: said(1, { choice_id: "other", input_value: "own column" }) }))).toBe("own column")
  expect(answerWords(member(1, { answer: said(1, { choice_id: "yes" }) }))).toBe("Yes, keep it")
  expect(answerIsText(member(1, { answer: said(1, { choice_id: "other", input_value: "own column" }) }))).toBe(true)
  expect(answerIsText(member(1, { answer: said(1, { choice_id: "yes" }) }))).toBe(false)
})

test("delivered only on runtime receipts", () => {
  expect(["pending", "queued", "admitted", "presented", "handled", "blocked", "closed"].map(state => deliveredState(member(1, { delivery_state: state as AttentionRecord["delivery_state"] }))))
    .toEqual(["saved", "saved", "delivered", "delivered", "delivered", "blocked", "not sent"])
})

test("hinge is the context's first short sentence, never a list or heading", () => {
  expect(hinge("A rejection is a condition, not a destination. Pending · In progress · Post-merge.")).toBe("A rejection is a condition, not a destination.")
  expect(hinge("- bullet first\n- second")).toBe("")
  expect(hinge(`${"long ".repeat(60)}.`)).toBe("")
})

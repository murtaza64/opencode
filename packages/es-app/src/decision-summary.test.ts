import { expect, test } from "bun:test"
import { decisionSummary } from "./decision-summary"

const options = [{ id: "ship", label: "Publish it" }, { id: "park", label: "Park it" }]

test("pending: every option listed, none chosen", () => {
  const summary = decisionSummary({ status: "open", options, answer: null, decision: null, recommendation: "ship" })
  expect(summary).toEqual({ pending: true, options: [{ label: "Publish it", chosen: false, recommended: true }, { label: "Park it", chosen: false, recommended: false }] })
})

test("answered with an option: that option is chosen, with when", () => {
  const summary = decisionSummary({ status: "answered", options, decision: null, answer: { id: "a", text: "", choice_id: "park", answered_at: 5 } })
  expect(summary.options.map(option => option.chosen)).toEqual([false, true])
  expect(summary.answeredAt).toBe(5)
  expect(summary.text).toBeUndefined()
})

test("answered in free text: no option chosen and the text is shown", () => {
  const summary = decisionSummary({ status: "answered", options, decision: null, answer: { id: "a", text: "Do both, Mini first", choice_id: null, answered_at: 5 } })
  expect(summary.options.some(option => option.chosen)).toBe(false)
  expect(summary.text).toBe("Do both, Mini first")
})

test("an option plus a note keeps both; an echo of the label is not repeated", () => {
  expect(decisionSummary({ status: "answered", options, decision: null, answer: { id: "a", text: "after the release", choice_id: "ship", answered_at: 5 } }).text).toBe("after the release")
  expect(decisionSummary({ status: "answered", options, decision: null, answer: { id: "a", text: "Publish it", choice_id: "ship", answered_at: 5 } }).text).toBeUndefined()
})

test("a choice that is not among the options is reported, not dropped", () => {
  expect(decisionSummary({ status: "decided", options, answer: null, decision: { choice_id: "later" } }).unknownChoice).toBe("later")
})

import { expect, test } from "bun:test"
import type { QuestionInfo } from "@opencode-ai/sdk/v2"
import { assembleQuestionAnswers, questionOptionLabel } from "./question-answer"

const questions: QuestionInfo[] = [
  {
    header: "Approach",
    question: "Which approach?",
    options: [
      { label: "Small patch (Recommended)", description: "Keep the seam narrow." },
      { label: "Rewrite", description: "Replace the module." },
    ],
  },
  {
    header: "Scope",
    question: "What else?",
    options: [{ label: "Tests", description: "Add coverage." }],
    multiple: true,
  },
]

test("assembles selected options followed by an optional note", () => {
  expect(assembleQuestionAnswers(questions, [["Rewrite"], ["Tests"]], ["Preserve the API", ""]).answers)
    .toEqual([["Rewrite", "Preserve the API"], ["Tests"]])
})

test("uses a note without an option as a custom answer", () => {
  expect(assembleQuestionAnswers([questions[1]!], [[]], ["Only document it"]))
    .toEqual({ answers: [["Only document it"]], missing: [] })
})

test("fills an empty answer from its recommended option", () => {
  expect(assembleQuestionAnswers([questions[0]!], [[]], [""]))
    .toEqual({ answers: [["Small patch (Recommended)"]], missing: [] })
  expect(questionOptionLabel("Small patch (Recommended)")).toBe("Small patch")
})

test("reports each answer with neither input nor a recommendation", () => {
  expect(assembleQuestionAnswers([questions[1]!], [[]], ["  "]))
    .toEqual({ answers: [[]], missing: [0] })
})

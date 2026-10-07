import type { QuestionInfo } from "@opencode-ai/sdk/v2"

export function assembleQuestionAnswers(questions: QuestionInfo[], selections: string[][], notes: string[]) {
  const missing: number[] = []
  const answers = questions.map((question, index) => {
    const note = notes[index]?.trim() ?? ""
    const selected = selections[index] ?? []
    const recommended = !selected.length && !note
      ? question.options.find((option) => option.label.endsWith("(Recommended)"))?.label
      : undefined
    const answer = selected.length ? [...selected] : recommended ? [recommended] : []
    if (note) answer.push(note)
    if (!answer.length) missing.push(index)
    return answer
  })
  return { answers, missing }
}

export function questionOptionLabel(label: string) {
  return label.endsWith("(Recommended)") ? label.slice(0, -"(Recommended)".length).trimEnd() : label
}

import { inputText, type AttentionRecord } from "./attention"

/** The ledger's recorded answers, not recommendations or locally selected options, determine progress. */
export const seriesProgress = (members: AttentionRecord[]) => {
  const ordered = members.toSorted((a, b) => a.series!.index - b.series!.index)
  const live = ordered.filter(record => record.status !== "withdrawn")
  return {
    ordered,
    live: live.length,
    answered: live.filter(record => !!record.answer).length,
    unanswered: live.filter(record => !record.answer),
    withdrawn: ordered.filter(record => record.status === "withdrawn"),
  }
}

/** A grilling session over one series: progress, the next question to ask, and each question's place in the
 * conversation. Presentation only; every question stays its own record with its own answer and delivery. */
export const grilling = (members: AttentionRecord[]) => {
  const progress = seriesProgress(members)
  // Published after the human started answering: the agent is following up on what was said.
  const firstAnswer = Math.min(...progress.ordered.flatMap(record => record.answer ? [record.answer.answered_at] : []))
  const questions = progress.ordered.map(record => {
    const cause = record.caused_by ? progress.ordered.find(other => other.series!.index === record.caused_by!.index && other.answer) : undefined
    return {
      record,
      index: record.series!.index,
      followUp: !!record.caused_by || record.created_at > firstAnswer,
      // Exact only when the producer named the answer it follows; never inferred from timing.
      cause: cause && { index: cause.series!.index, said: answerWords(cause)! },
    }
  })
  const live = questions.filter(question => question.record.status !== "withdrawn")
  return {
    ...progress,
    questions,
    followUps: live.filter(question => question.followUp).length,
    /** The lowest-index live question still waiting for an answer, or undefined when every one is answered. */
    next: live.find(question => !question.record.answer && (question.record.status === "open" || question.record.status === "decided")),
  }
}

/** A recorded answer in the human's own words: the text they wrote, else the option they chose. */
export const answerWords = (record: AttentionRecord) => {
  const answer = record.answer
  if (!answer) return
  const option = record.options.find(item => item.id === answer.choice_id)
  const supplied = answer.input_value === undefined ? undefined : inputText(option, answer.input_value)
  return answer.text.trim() || supplied || option?.label || "Answered"
}

/** True when the answer is the human's own words rather than one of the offered choices. */
export const answerIsText = (record: AttentionRecord) =>
  !!record.answer && (!!record.answer.text.trim() || (record.answer.input_value !== undefined && record.options.find(item => item.id === record.answer!.choice_id)?.input?.kind === "text"))

/** Delivery evidence in a word: an answer counts as delivered once the agent's runtime admitted it. */
export const deliveredState = (record: AttentionRecord) =>
  ["admitted", "presented", "handled"].includes(record.delivery_state) ? "delivered" as const
    : record.delivery_state === "blocked" ? "blocked" as const
      : record.delivery_state === "closed" || record.delivery_state === "not-requested" ? "not sent" as const
        : "saved" as const

/** The first sentence of a question's context: the hinge shown under the question. Long openers stay in More context. */
export const hinge = (context: string) => {
  const first = context.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ") ?? ""
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first
  return sentence.length <= 200 && !/^[#>|`-]/.test(sentence) ? sentence : ""
}

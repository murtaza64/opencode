/* What a decision offered and what came of it, for the sidebar hover/focus card. Read from the attention
 * record only: its options, its answer (choice and/or free text) and when it was answered. The ledger does
 * not record who answered, so the card never names anyone. */
import type { AttentionRecord } from "./attention"

export type DecisionSummary = {
  pending: boolean
  options: { label: string; chosen: boolean; recommended: boolean }[]
  /** Free text the answer carried: the whole answer when no option was chosen, else a note beside it. */
  text?: string
  /** The chosen option's id when it is not among the offered options (an older or edited record). */
  unknownChoice?: string
  answeredAt?: number
}

export const decisionSummary = (record: Pick<AttentionRecord, "status" | "options" | "answer" | "decision" | "recommendation">): DecisionSummary => {
  const pending = record.status === "open" || record.status === "snoozed"
  const decided = typeof record.decision === "object" && record.decision ? record.decision.choice_id : undefined
  const choice = pending ? undefined : record.answer?.choice_id ?? decided ?? undefined
  const options = record.options.map(option => ({ label: option.label, chosen: option.id === choice, recommended: option.id === record.recommendation }))
  const chosenLabel = options.find(option => option.chosen)?.label
  const free = pending ? undefined : record.answer?.text?.trim() || (typeof record.decision === "string" ? record.decision.trim() : undefined) || undefined
  return {
    pending,
    options,
    ...(free && free !== chosenLabel ? { text: free } : {}),
    ...(choice && !chosenLabel ? { unknownChoice: choice } : {}),
    ...(!pending && record.answer?.answered_at ? { answeredAt: record.answer.answered_at } : {}),
  }
}

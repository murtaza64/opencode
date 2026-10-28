import type { AttentionRecord } from "./attention"

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

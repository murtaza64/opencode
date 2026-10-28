import { expect, test } from "bun:test"
import type { AttentionRecord } from "./attention"
import { seriesProgress } from "./attention-series"

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

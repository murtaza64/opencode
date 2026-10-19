import { expect, test } from "bun:test"
import { wingmanPrs, wingmanStatus } from "./wingman"

test("Wingman status distinguishes working, waiting, completed, and failures", () => {
  expect(wingmanStatus("processing")).toEqual({ label: "working", chip: "busy" })
  expect(wingmanStatus("waiting")).toEqual({ label: "waiting", chip: "parked" })
  expect(wingmanStatus("ended")).toEqual({ label: "ended", chip: "plain" })
  expect(wingmanStatus("failed")).toEqual({ label: "failed", chip: "failing" })
  expect(wingmanStatus("timed_out")).toEqual({ label: "timed out", chip: "failing" })
  expect(wingmanStatus()).toEqual({ label: "unknown", chip: "plain" })
})

test("Wingman PR list tolerates missing fields and splits whitespace without unsafe links", () => {
  expect(wingmanPrs()).toEqual([])
  expect(wingmanPrs("  https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2  javascript:alert(1) "))
    .toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"])
})

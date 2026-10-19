import { describe, expect, test } from "bun:test"
import { wingmanPrs, wingmanRunUrl, wingmanStatus, wingmanSyncedAt } from "./wingman"

test("Wingman status distinguishes working, waiting, completed, and failures", () => {
  expect(wingmanStatus("processing")).toEqual({ label: "working", chip: "busy" })
  expect(wingmanStatus("waiting")).toEqual({ label: "waiting", chip: "parked" })
  expect(wingmanStatus("ended")).toEqual({ label: "ended", chip: "plain" })
  expect(wingmanStatus("failed")).toEqual({ label: "failed", chip: "failing" })
  expect(wingmanStatus("timed_out")).toEqual({ label: "timed out", chip: "failing" })
  expect(wingmanStatus()).toEqual({ label: "starting", chip: "plain" })
})

test("Wingman PR list tolerates missing fields and splits whitespace without unsafe links", () => {
  expect(wingmanPrs()).toEqual([])
  expect(wingmanPrs("  https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2  javascript:alert(1) "))
    .toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"])
})

describe("wingman lane freshness and links", () => {
  test("synced time parses the dashboard's UTC stamp", () => {
    expect(wingmanSyncedAt({ "wingman-synced": "2026-10-19T20:00:00Z" })).toBe(Date.parse("2026-10-19T20:00:00Z"))
  })

  test("a lane never synced has no freshness", () => {
    expect(wingmanSyncedAt({})).toBeUndefined()
  })

  test("run links only point at Temporal Cloud", () => {
    expect(wingmanRunUrl({ "wingman-url": "https://cloud.temporal.io/namespaces/x" })).toBe("https://cloud.temporal.io/namespaces/x")
    expect(wingmanRunUrl({ "wingman-url": "javascript:alert(1)" })).toBeUndefined()
  })
})

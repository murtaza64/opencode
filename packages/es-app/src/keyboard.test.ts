import { expect, test } from "bun:test"
import { createSequenceMatcher } from "./keyboard"

test("a full sequence matches and clears pending keys", () => {
  const matcher = createSequenceMatcher(() => true)
  expect(matcher.feed("g")).toEqual({
    kind: "prefix",
    next: [
      { key: "d", id: "goDesk" },
      { key: "a", id: "goAgents" },
      { key: "u", id: "goUsage" },
      { key: "C", id: "goCloud" },
      { key: "o", id: "goNewSession" },
    ],
  })
  expect(matcher.feed("C")).toEqual({ kind: "match", id: "goCloud" })
  expect(matcher.pending()).toEqual([])
})

test("an unbound key after a prefix cancels", () => {
  const matcher = createSequenceMatcher(() => true)
  matcher.feed("g")
  expect(matcher.feed("z")).toEqual({ kind: "none" })
  expect(matcher.pending()).toEqual([])
})

test("planned sequences never match", () => {
  const matcher = createSequenceMatcher(() => true)
  matcher.feed("g")
  expect(matcher.feed("p")).toEqual({ kind: "none" })
})

test("sequences without an installed action are skipped", () => {
  const matcher = createSequenceMatcher((id) => id === "reference")
  expect(matcher.feed("g")).toEqual({ kind: "none" })
  expect(matcher.feed("?")).toEqual({ kind: "match", id: "reference" })
})

test("leader Space then ? opens the reference", () => {
  const matcher = createSequenceMatcher(() => true)
  expect(matcher.feed("Space")).toEqual({ kind: "prefix", next: [{ key: "?", id: "referenceLeader" }] })
  expect(matcher.feed("?")).toEqual({ kind: "match", id: "referenceLeader" })
})

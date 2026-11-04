import { expect, test } from "bun:test"
import { changeCall, changeNoteLine, changeNotes } from "./surface-notes"

const notes = [{ revision: 5, text: "Pick A or B" }, { revision: 3, text: "Header redrawn" }]

test("a list row shows the current revision's note, says none was given on a republish, and nothing for a first publish", () => {
  expect(changeNoteLine({ revision: 5, whats_new: "Pick A or B" })).toBe("Pick A or B")
  expect(changeNoteLine({ revision: 4, whats_new: null })).toBe("No change note provided")
  expect(changeNoteLine({ revision: 4 })).toBe("No change note provided")
  expect(changeNoteLine({ revision: 1, whats_new: null })).toBeUndefined()
})

test("a reader names the revision last opened and the earlier notes only when revisions were missed", () => {
  expect(changeNotes({ revision: 5, whats_new: "Pick A or B", notes }, 4)).toEqual({ current: "Pick A or B" })
  expect(changeNotes({ revision: 5, whats_new: "Pick A or B", notes })).toEqual({ current: "Pick A or B" })
  expect(changeNotes({ revision: 5, whats_new: "Pick A or B", notes }, 1)).toEqual({
    current: "Pick A or B",
    since: { base: 1, earlier: [{ revision: 3, text: "Header redrawn" }], unnoted: 2 },
  })
})

test("the latest note never covers missed revisions: a missed revision without a note is counted, not filled in", () => {
  const since = changeNotes({ revision: 5, whats_new: null, notes: [] }, 2).since
  expect(since).toEqual({ base: 2, earlier: [], unnoted: 2 })
})

test("a row's call to action comes only from what the author said", () => {
  expect(changeCall({ revision: 11 })).toEqual([])
  expect(changeCall({ revision: 11, change: { base: 10, intent: null, look: [], respond: null } })).toEqual([])
  expect(changeCall({ revision: 11, change: { base: 10, intent: "fyi", look: [{ label: "Sources and repro" }], respond: null } }))
    .toEqual(["Since r10", "FYI", "Look at: Sources and repro"])
  expect(changeCall({ revision: 11, change: { base: 8, intent: "review", look: [{ label: "A", id: "a" }, { label: "B" }], respond: "Keep A?" } }))
    .toEqual(["Since r8", "Review", "Look at: A +1"])
})

test("a stale base: a device that last opened an older revision than the note's base is told so", () => {
  const surface = { revision: 11, whats_new: "Provenance fixed", notes: [{ revision: 9, text: "Ran r9" }], change: { base: 10, intent: "fyi" as const, look: [], respond: null } }
  expect(changeNotes(surface, 10)).toEqual({ current: "Provenance fixed" })
  expect(changeNotes(surface, 8)?.since).toEqual({ base: 8, earlier: [{ revision: 9, text: "Ran r9" }], unnoted: 1 })
  // An author base older than the previous revision: opening the previous one is still "since" the base, not stale.
  expect(changeNotes({ ...surface, change: { ...surface.change, base: 7 } }, 9)).toEqual({ current: "Provenance fixed" })
})

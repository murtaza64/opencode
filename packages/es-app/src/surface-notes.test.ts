import { expect, test } from "bun:test"
import { changeNoteLine, changeNotes } from "./surface-notes"

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

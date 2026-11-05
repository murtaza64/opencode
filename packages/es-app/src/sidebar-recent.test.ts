import { expect, test } from "bun:test"
import { changedSinceOpened, holdOrder, newcomers, recentOrder, type RecentItem } from "./sidebar-recent"

const item = (key: string, updated?: number, opened?: number): RecentItem => ({ kind: "surface", key, title: key, updated, opened })

test("blended puts changed-since-opened first, then MRU; never-opened counts as new", () => {
  const rows = [
    item("opened-old", 10, 100),
    item("changed", 120, 100),
    item("never", 20),
    item("opened-new", 10, 300),
    item("undated", undefined, 50),
  ]
  expect(recentOrder(rows, "blended").map((row) => row.key)).toEqual(["changed", "never", "opened-new", "opened-old", "undated"])
})

test("updated orders by change time, undated last; ties by key", () => {
  expect(recentOrder([item("b", 5), item("a", 5), item("z"), item("n", 9)], "updated").map((row) => row.key)).toEqual(["n", "a", "b", "z"])
})

test("opened orders by MRU, undated last; ties by updated then key", () => {
  expect(recentOrder([item("b", 1, 10), item("a", 2, 10), item("z", 9), item("n", 1, 20)], "opened").map((row) => row.key)).toEqual(["n", "a", "b", "z"])
})

test("changedSinceOpened compares the source's own timestamps", () => {
  expect(changedSinceOpened({ updated: 10 })).toBe(true)
  expect(changedSinceOpened({ updated: 10, opened: 10 })).toBe(false)
  expect(changedSinceOpened({ updated: 11, opened: 10 })).toBe(true)
  expect(changedSinceOpened({ opened: 10 })).toBe(false)
})

test("refetch keeps shown order and reports only genuinely new keys", () => {
  expect(holdOrder(["a", "b", "c"], ["c", "b", "d"])).toEqual(["b", "c"])
  expect(newcomers(["a", "b"], ["c", "b", "a"])).toEqual(["c"])
})

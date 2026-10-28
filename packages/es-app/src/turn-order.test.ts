import { expect, test } from "bun:test"
import { byBoundary, dateGroup } from "./turn-order"

const noon = new Date(2026, 9, 28, 12).getTime()
const H = 3_600_000

test("Local, Mini and Wingman rows share one order by last turn boundary; undated rows sit last in a stable order", () => {
  const rows = [
    { key: "cloud:opencode/old-task", boundary: noon - 8 * 24 * H }, // Wingman: old activity, fetched just now
    { key: "ses_local", boundary: noon - H },
    { key: "mini:ses_m", boundary: noon - 2 * H },
    { key: "cloud:opencode/unknown" },
    { key: "cloud:opencode/active", boundary: noon - 30 * 60_000 },
    { key: "ses_undated" },
  ]
  expect([...rows].sort(byBoundary).map((row) => row.key)).toEqual(["cloud:opencode/active", "ses_local", "mini:ses_m", "cloud:opencode/old-task", "cloud:opencode/unknown", "ses_undated"])
  // Reloading in another order gives the same result.
  expect([...rows].reverse().sort(byBoundary).map((row) => row.key)).toEqual([...rows].sort(byBoundary).map((row) => row.key))
})

test("date groups come from the boundary only; unknown is undated, never today", () => {
  expect(dateGroup(noon - H, noon)).toBe("today")
  expect(dateGroup(noon - 20 * H, noon)).toBe("yesterday")
  expect(dateGroup(noon - 3 * 24 * H, noon)).toBe("week")
  expect(dateGroup(noon - 30 * 24 * H, noon)).toBe("older")
  expect(dateGroup(undefined, noon)).toBe("undated")
})

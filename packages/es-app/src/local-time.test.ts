import { afterEach, expect, test } from "bun:test"
import { clockTime, dayLabel, exactTime, localISO, shortDateTime } from "./local-time"

const zone = process.env.TZ
afterEach(() => { process.env.TZ = zone })
// 2026-11-03T15:24:42Z, a Mini-hosted item's epoch; the viewing device decides how it reads.
const AT = Date.UTC(2026, 10, 3, 15, 24, 42)

test("the same epoch reads in the viewing device's zone: New York vs UTC", () => {
  process.env.TZ = "America/New_York"
  expect(localISO(AT)).toBe("2026-11-03T10:24:42-05:00")
  expect(clockTime(AT)).toMatch(/10:24/)
  process.env.TZ = "UTC"
  expect(localISO(AT)).toBe("2026-11-03T15:24:42Z")
  expect(clockTime(AT)).toMatch(/15:24|03:24/)
})

test("DST boundary: the offset follows the date, not today", () => {
  process.env.TZ = "America/New_York"
  expect(localISO(Date.UTC(2026, 10, 1, 5, 30))).toBe("2026-11-01T01:30:00-04:00") // before the 06:00Z fall-back
  expect(localISO(Date.UTC(2026, 10, 1, 6, 30))).toBe("2026-11-01T01:30:00-05:00") // after
})

test("day rollover is the device's day: 03:00Z on Nov 4 is still Nov 3 in New York", () => {
  const late = Date.UTC(2026, 10, 4, 3, 0)
  process.env.TZ = "America/New_York"
  expect(dayLabel(late)).toMatch(/Nov 3/)
  process.env.TZ = "UTC"
  expect(dayLabel(late)).toMatch(/Nov 4/)
})

test("the hover/aria text names the full local time and the labelled exact ISO; invalid input reads empty", () => {
  process.env.TZ = "America/New_York"
  expect(exactTime(AT)).toMatch(/November 3, 2026.*10:24:42.*\(exact: 2026-11-03T10:24:42-05:00\)$/)
  expect(shortDateTime(Number.NaN, "unknown")).toBe("unknown")
  expect(exactTime(undefined)).toBe("")
})

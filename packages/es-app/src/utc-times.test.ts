import { afterEach, expect, test } from "bun:test"
import { localReading } from "./utc-times"

const zone = process.env.TZ
afterEach(() => { process.env.TZ = zone })

test("a UTC clock reads as the reader's time of day, claiming no date", () => {
  process.env.TZ = "America/New_York"
  expect(localReading("10:24Z", Date.UTC(2026, 10, 3, 12))).toMatch(/^Your time: 0?5:24.*\(time of day; 10:24Z is UTC\)$/)
})

test("an ISO time with Z or an offset reads as the reader's full local date and time", () => {
  process.env.TZ = "America/New_York"
  expect(localReading("2026-11-03T15:24:42Z")).toMatch(/November 3, 2026.*10:24:42.*exact: 2026-11-03T10:24:42-05:00/)
  expect(localReading("2026-11-03T17:24:42+02:00")).toMatch(/exact: 2026-11-03T10:24:42-05:00/)
})

import { expect, test } from "bun:test"
import { ArchiveFailure, isSummary } from "./desk-archive"

test("summaries are the sessions/ docs", () => {
  expect(isSummary("sessions/2026-11-23-ses_abcdef")).toBe(true)
  expect(isSummary("release-flow")).toBe(false)
})

test("a missing route reads as no archive; a missing doc or a conflict does not", () => {
  expect(new ArchiveFailure("Not Found", 404).absent).toBe(true)
  expect(new ArchiveFailure("no archive doc x", 404).absent).toBe(false)
  expect(new ArchiveFailure("changed", 409).conflict).toBe(true)
})

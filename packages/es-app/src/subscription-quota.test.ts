import { expect, test } from "bun:test"
import type { QuotaProvider, QuotaView } from "./api"
import { quotaRows } from "./subscription-quota"

const NOW = Date.parse("2026-11-01T20:00:00Z")
const view = (...providers: QuotaProvider[]): QuotaView => ({ schema: "es-quota/1", checkedAt: new Date(NOW).toISOString(), providers })
const claude = (extra: Partial<QuotaProvider> = {}): QuotaProvider => ({
  provider: "claude", state: "ok", source: "claude-statusline", observedAt: "2026-11-01T19:55:00Z",
  windows: [{ id: "five_hour", usedPercent: 42.4, resetsAt: "2026-11-01T22:30:00Z" }, { id: "seven_day", usedPercent: 0, resetsAt: "2026-11-04T21:00:00Z" }],
  ...extra,
})

test("no snapshot file reads as Not configured with no bars", () => {
  expect(quotaRows(view({ provider: "claude", state: "not-configured", windows: [] }), NOW)).toEqual([
    { provider: "claude", label: "Claude", status: "Not configured", experimental: false, bars: [] }])
})

test("Claude with both windows shows each used percent and a reset countdown", () => {
  expect(quotaRows(view(claude()), NOW)[0]!.bars).toEqual([
    { id: "five_hour", label: "5-hour", percent: 42, reset: "resets in 2h 30m" },
    { id: "seven_day", label: "7-day", percent: 0, reset: "resets in 3d 1h" },
  ])
})

test("a window the snapshot lacks is absent, not shown as 0", () => {
  const rows = quotaRows(view(claude({ windows: [{ id: "five_hour", usedPercent: 10, resetsAt: "2026-11-01T21:00:00Z" }] })), NOW)
  expect(rows[0]!.bars.map((bar) => bar.id)).toEqual(["five_hour"])
})

test("a stale snapshot keeps its last values, labelled stale, with no countdown", () => {
  const row = quotaRows(view(claude({ state: "stale", staleSince: "2026-11-01T19:30:00Z" })), NOW)[0]!
  expect(row.status?.startsWith("Stale since ")).toBe(true)
  expect(row.bars.map((bar) => bar.reset)).toEqual([undefined, undefined])
})

test("a malformed snapshot is Unavailable with its reason and no bars", () => {
  expect(quotaRows(view({ provider: "claude", state: "unavailable", reason: "invalid", windows: [] }), NOW)[0]).toMatchObject({ status: "Unavailable (invalid)", bars: [] })
})

test("Codex from an unpinned CLI version is labelled experimental", () => {
  const row = quotaRows(view({ provider: "codex", state: "ok", pinned: false, observedAt: "2026-11-01T19:59:00Z",
    windows: [{ id: "codex/primary", usedPercent: 10, resetsAt: "2026-11-01T20:45:00Z", windowDurationMins: 300 }] }), NOW)[0]!
  expect(row).toMatchObject({ label: "Codex", experimental: true, status: undefined })
  expect(row.bars).toEqual([{ id: "codex/primary", label: "primary (5-hour)", percent: 10, reset: "resets in 45m" }])
})

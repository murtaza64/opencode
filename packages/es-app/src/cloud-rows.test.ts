import { expect, test } from "bun:test"
import { cloudRows, mergeAgentRows } from "./cloud-rows"

const lane = (lane: string, owner: string, status: string, activity?: string, synced?: string) =>
  ({ editspace: "opencode", lane, owner, record: { lane, owner, "wingman-status": status, ...(activity ? { "wingman-activity": activity } : {}), ...(synced ? { "wingman-synced": synced } : {}) } as never })

test("pinned cloud agents are always rows; unpinned ones come from the view's own discovery", () => {
  const working = lane("fix-auth", "wingman:abc", "processing", "2026-10-28T10:00:00Z")
  const other = lane("docs", "wingman:def", "waiting", "2026-10-28T09:00:00Z")
  const rows = cloudRows({ pins: [{ editspace: "opencode", lane: "fix-auth", owner: "wingman:abc" }], observed: [working, other], other: [other], snapshots: {} })
  expect(rows.map((row) => [row.title, row.pinned, row.status.label, row.runtime])).toEqual([["fix-auth", true, "working", "cloud"], ["docs", false, "waiting", "cloud"]])
  expect(rows[0]!.updated).toBeUndefined()
  expect(rows[0]!.changedAt).toBe(Date.parse("2026-10-28T10:00:00Z"))
  expect(rows[0]!.href).toBe("/cloud?es=opencode&lane=fix-auth&owner=wingman%3Aabc")
})

test("a pinned agent the source no longer lists says so; an unreadable source keeps rows marked stale", () => {
  const rows = cloudRows({ pins: [{ editspace: "opencode", lane: "gone", owner: "wingman:zzz" }], observed: [], other: [], snapshots: { opencode: { error: "Cloud lane source unavailable" } } })
  expect(rows).toMatchObject([{ title: "gone", status: { label: "owner not observed" }, stale: true, updated: undefined }])
})

test("one list newest first; cloud rows are undated (last) and never replace a session with the same name", () => {
  const sessions = [{ id: "ses_a", title: "fix-auth", updated: 5 }, { id: "ses_b", title: "old", updated: 1 }]
  const cloud = cloudRows({ pins: [], observed: [], other: [lane("fix-auth", "wingman:abc", "processing", new Date(3).toISOString())], snapshots: {} })
  expect(mergeAgentRows(sessions, cloud).map((row) => [row.kind, row.kind === "session" ? row.item.id : row.item.title])).toEqual([["session", "ses_a"], ["session", "ses_b"], ["cloud", "fix-auth"]])
})

test("an old agent fetched just now never ranks above a session: Wingman order is unknown until real turn boundaries exist", () => {
  const old = lane("old-task", "wingman:old", "ended", "2026-10-20T09:00:00Z", "2026-10-28T11:59:59Z")
  const cloud = cloudRows({ pins: [], observed: [old], other: [old], snapshots: {} })
  expect(cloud[0]).toMatchObject({ updated: undefined, changedAt: Date.parse("2026-10-20T09:00:00Z") })
  const merged = mergeAgentRows([{ id: "ses_local", title: "Local work", updated: 1 }], cloud)
  expect(merged.map((row) => row.kind)).toEqual(["session", "cloud"])
})

test("an agent whose activity was never seen is undated (last), never dated by its fetch time", () => {
  const unknown = lane("unknown", "wingman:u", "ended", undefined, "2026-10-28T11:59:59Z")
  const [row] = cloudRows({ pins: [], observed: [unknown], other: [unknown], snapshots: {} })
  expect(row!.updated).toBeUndefined()
  expect(row!.changedAt).toBeUndefined()
  expect(row!.status.label).toBe("ended")
})

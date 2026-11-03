import { expect, test } from "bun:test"
import { deskItems } from "./desk"
import type { HostFeed } from "./host-feed"
import { needsYou, needsYouFromInputs, staleArtifact } from "./needs-you"
import { deliverables, type Surface } from "./surfaces"
import { workCountLabel, workQueue } from "./work-queue"

const attention = (id: string, extra = {}) =>
  ({ id, editspace: "opencode", revision: 1, status: "open", kind: "decision", title: `Decision ${id}`, options: [], delivery_state: "not-requested", created_at: 1, source_ref: { session_id: "ses_a", directory: "/r" }, ...extra }) as never
const feed = (id: string, label: string, state: Record<string, unknown>) =>
  ({ host: { id, label, origin: `http://127.0.0.1:${id === "mini" ? 1 : 2}` }, state: () => ({ status: "ready", rows: [], scoped: true, decisions: [], requests: [], surfaces: [], ...state }) }) as unknown as HostFeed
const surface = (id: string, extra: Partial<Surface> = {}) =>
  ({ id, title: id, summary: null, kind: "url", owner: "lane", lane: null, editspace: "opencode", updated_at: 1, revision: 1, health: { state: "ok" }, purpose: "deliverable", ...extra }) as Surface

// One host's sources the way desk-queue.tsx passes them to deskItems: an open decision, a two-question
// series, a resolved record, a pending permission, a request that is no longer pending and a failure.
const items = deskItems({
  records: [
    attention("11111111-1111-4111-8111-111111111111"),
    attention("22222222-2222-4222-8222-222222222222", { origin_session: "ses_p", series: { id: "s", index: 0, title: "Setup" } }),
    attention("33333333-3333-4333-8333-333333333333", { origin_session: "ses_p", series: { id: "s", index: 1 } }),
    attention("44444444-4444-4444-8444-444444444444", { status: "resolved" }),
  ],
  attentionChecked: 1,
  requests: [
    { kind: "permission", id: "per_1", session: "ses_b", directory: "/r", project: "opencode", title: "Edit", state: "pending", checked: 1 },
    { kind: "question", id: "que_1", session: "ses_c", directory: "/r", project: "opencode", title: "Ask", state: "unknown", checked: 1 },
  ] as never,
  failures: [{ sessionID: "ses_f", directory: "/r", messageID: "msg_1" }] as never,
  failuresChecked: 1,
  title: () => undefined,
  project: () => "opencode",
})
const fresh = deliverables([surface("new"), surface("seen", { seen: true }), surface("opened"), surface("board", { purpose: "board" })], new Map([["opened:1", true]])).fresh

test("the count is this host's items, other Work hosts' decisions and fresh deliverables, as the sidebar band shows it", () => {
  const feeds = [feed("mini", "Mac Mini", { decisions: [attention("11111111-1111-4111-8111-111111111111")] })]
  const result = needsYou({ items, feeds, fresh })
  expect(result.entries.map((entry) => entry.key)).toEqual([
    "attention:opencode:11111111-1111-4111-8111-111111111111",
    "series:opencode:ses_p:s",
    "permission:/r:per_1",
    "failure:ses_f",
    // The same record ID on the Mini stays its own entry.
    "mini~attention:opencode:11111111-1111-4111-8111-111111111111",
  ])
  expect(result.fresh.map((item) => item.id)).toEqual(["new"])
  expect(result.label).toEqual({ text: "6", title: undefined })
  expect(result.decisions).toEqual({ text: "5", title: undefined })
  // Parity with the formula nav-tabs.tsx renders today.
  const queue = workQueue(items, feeds)
  expect(result.label).toEqual(workCountLabel({ ...queue, count: queue.count + fresh.length }))
  expect(result.decisions).toEqual(workCountLabel(queue))
})

test("a host whose decisions are not current keeps its last entries and makes the count partial, never zero", () => {
  const result = needsYou({ items: [], feeds: [feed("mini", "Mac Mini", { status: "unavailable", decisions: [attention("11111111-1111-4111-8111-111111111111")] }), feed("wing", "Wingman", { decisionsStale: true })], fresh: [] })
  expect([result.count, result.partial, result.behind]).toEqual([1, true, ["Mac Mini", "Wingman"]])
  expect(result.label).toEqual({ text: "1+", title: "Mac Mini, Wingman: not current" })
})

test("another Work host's fresh deliverables are its own Try entries; Done, boards, Personal and read-only hosts never count", () => {
  const personal = (id: string, extra = {}) => ({ ...feed(id, id, { surfaces: [surface("theirs")] }), host: { id, label: id, origin: "http://127.0.0.1:3", profile: "personal", ...extra } }) as unknown as HostFeed
  const feeds = [
    feed("mini", "Mac Mini", { surfaces: [surface("new", { kind: "path" }), surface("done", { seen: true }), surface("board", { purpose: "board" })] }),
    personal("excalibur"),
    personal("ygnium", { readOnly: true }),
  ]
  const result = needsYou({ items: [], feeds, fresh })
  // The same deliverable ID here and on the Mini stays two entries.
  expect(result.fresh.map((item) => item.id)).toEqual(["new"])
  expect(result.tries.map((entry) => [entry.key, entry.host, entry.href])).toEqual([["mini~surface:new", "mini", "/?item=mini~surface%3Anew"]])
  expect(result.tries[0]?.remote).toMatchObject({ kind: "surface", frame: "host", surface: { id: "new", revision: 1 } })
  expect(result.label).toEqual({ text: "2", title: undefined })
  expect(result.decisions).toEqual({ text: "0", title: undefined })
})

test("a host whose Surface list is not current keeps its last Try entries and makes the count partial", () => {
  const result = needsYou({ items: [], feeds: [feed("mini", "Mac Mini", { surfacesStale: true, surfaces: [surface("new")] })], fresh: [] })
  expect([result.tries.map((entry) => [entry.key, entry.stale]), result.label]).toEqual([[["mini~surface:new", true]], { text: "1+", title: "Mac Mini: not current" }])
})

test("the Dock count carries other Work hosts' fresh deliverables like the band", () => {
  const feeds = [feed("mini", "Mac Mini", { surfaces: [surface("report")] })]
  expect(needsYouFromInputs(inputs(), feeds)!.label).toEqual(appPath(feeds).label)
  expect(needsYouFromInputs(inputs(), feeds)!.count).toBe(needsYouFromInputs(inputs(), [])!.count + 1)
})

test("nothing waiting anywhere is zero only when every host is current", () => {
  expect(needsYou({ items: [], feeds: [feed("mini", "Mac Mini", {})], fresh: [] }).label).toEqual({ text: "0", title: undefined })
})

// --- needs-you-inputs/1 (the dashboard read a non-page client uses) at parity with the app's own reads

const ok = { checked_at: 1, ok: true }
const failed = (sessionID: string, messageID = "msg_1") => ({ sessionID, messageID, directory: "/r", error: { name: "ProviderError" } })
const brief = "ses_fdjob_0123456789abcdef01234567"
const task = "ses_fdtask_0123456789abcdef01234567"
const records = [
  attention("11111111-1111-4111-8111-111111111111"),
  // A snoozed decision whose time came: the dashboard store wakes it to open before serving it.
  attention("55555555-5555-4555-8555-555555555555", { snoozed_until: null, revision: 3 }),
  attention("66666666-6666-4666-8666-666666666666", { kind: "review", artifact: { title: "Week review", url: "https://x.test/", revision: 2 } }),
]
const requestRows = [{ kind: "permission", id: "per_1", session: "ses_b", directory: "/r", project: "opencode", title: "Edit", state: "pending", checked: 1 }] as never[]
const surfaces = [surface("new"), surface("seen", { seen: true })]
const inputs = (overrides: Record<string, unknown> = {}) => ({
  records, projects: [{ editspace: "opencode", available: true }], partial: false, limit: 200,
  inputs: {
    schema: "needs-you-inputs/1", boot: "b1", rev: 4,
    requests: requestRows,
    failures: [failed(brief), failed(task), failed("ses_ignored"), failed("ses_plain")],
    ignores: [{ sessionID: "ses_ignored", messageID: "msg_1" }],
    deliverables: surfaces,
    sources: { requests: ok, failures: ok, ignores: ok, deliverables: ok },
    ...overrides,
  },
}) as never

// The app's path over the same data: desk-queue.tsx drops brief-job sessions and ignored failures
// before deskItems, and the band adds fresh deliverables.
const appPath = (feeds: HostFeed[], ignoredSessions = ["ses_ignored"]) => {
  const briefJobs = new Set([brief])
  const local = deskItems({
    records: records as never,
    attentionChecked: 0,
    requests: requestRows,
    failures: [failed(brief), failed(task), failed("ses_ignored"), failed("ses_plain")].filter((item) => !briefJobs.has(item.sessionID) && !ignoredSessions.includes(item.sessionID)) as never,
    failuresChecked: 0,
    title: () => undefined,
    project: () => undefined,
  })
  return needsYou({ items: local, feeds, fresh: deliverables(surfaces, new Map()).fresh })
}

test("the dashboard inputs give the app's entries and count: brief jobs out, desk tasks in, ignored out, review in", () => {
  const feeds = [feed("mini", "Mac Mini", { decisions: [attention("77777777-7777-4777-8777-777777777777")] })]
  const result = needsYouFromInputs(inputs(), feeds)!
  expect(result.entries.map((entry) => entry.key)).toEqual(appPath(feeds).entries.map((entry) => entry.key))
  expect(result.entries.map((entry) => entry.key)).toEqual([
    "attention:opencode:11111111-1111-4111-8111-111111111111",
    "attention:opencode:55555555-5555-4555-8555-555555555555",
    "attention:opencode:66666666-6666-4666-8666-666666666666",
    "permission:/r:per_1",
    `failure:${task}`,
    "failure:ses_plain",
    "mini~attention:opencode:77777777-7777-4777-8777-777777777777",
  ])
  expect(result.fresh.map((item) => item.id)).toEqual(["new"])
  expect(result.label).toEqual(appPath(feeds).label)
  expect(result.label).toEqual({ text: "8", title: undefined })
})

test("an ignore added after hydration leaves the count at the next read", () => {
  const before = needsYouFromInputs(inputs(), [])!
  const after = needsYouFromInputs(inputs({ ignores: [{ sessionID: "ses_ignored", messageID: "msg_1" }, { sessionID: "ses_plain", messageID: "msg_1" }] }), [])!
  expect([before.count, after.count]).toEqual([7, 6])
  expect(after.count).toBe(appPath([], ["ses_ignored", "ses_plain"]).count)
})

test("a deliverable marked seen on the dashboard is no longer fresh", () => {
  const result = needsYouFromInputs(inputs({ deliverables: [surface("new", { seen: true })] }), [])!
  expect(result.fresh).toEqual([])
})

test("a source never read gives no number; a source not current or a stale host gives N+", () => {
  expect(needsYouFromInputs(inputs({ sources: { requests: ok, failures: { checked_at: null, ok: false }, ignores: ok, deliverables: ok } }), [])).toBeUndefined()
  expect(needsYouFromInputs(inputs({ sources: { requests: ok, failures: { checked_at: 1, ok: false }, ignores: ok, deliverables: ok } }), [])!.label.text).toBe("7+")
  expect(needsYouFromInputs(inputs(), [feed("mini", "Mac Mini", { status: "unavailable" })])!.label).toEqual({ text: "7+", title: "Mac Mini: not current" })
})

test("an editspace at the page limit makes the count partial", () => {
  expect(needsYouFromInputs({ ...(inputs() as object), limit: 3 } as never, [])!.label.text).toBe("7+")
})

const local = (records: unknown[]) => deskItems({ records: records as never, attentionChecked: 1, requests: [], failures: [], failuresChecked: 1, title: () => undefined, project: () => "opencode" })

test("a decision that names a fresh Surface and that Surface are one item, counted once", () => {
  const board = surface("board-7", { revision: 7 })
  const result = needsYou({ items: local([attention("a1", { artifact: { title: "Board", surface: "board-7", revision: 7 } })]), feeds: [], fresh: [board], local: [board] })
  expect(result.entries).toEqual([])
  expect(result.fresh).toEqual([])
  expect(result.linked.map((item) => [item.key, item.href, item.decisions.map((record) => record.id), item.fresh])).toEqual([["surface:board-7", "/?item=surface%3Aboard-7", ["a1"], true]])
  expect(result.count).toBe(1)
  expect(result.decisions.text).toBe("1")
})

test("a decision about a Surface already seen still opens with it, as one item", () => {
  const board = surface("board-7", { revision: 7, seen: true })
  const result = needsYou({ items: local([attention("a1", { artifact: { title: "Board", surface: "board-7", revision: 7 } })]), feeds: [], fresh: [], local: [board] })
  expect(result.linked.map((item) => [item.key, item.fresh])).toEqual([["surface:board-7", false]])
  expect(result.count).toBe(1)
})

test("without an explicit Surface reference, or with an unlisted one, both rows stay as they are", () => {
  const board = surface("board-7")
  const result = needsYou({ items: local([attention("a1", { title: "board-7" }), attention("a2", { artifact: { title: "Gone", surface: "gone", revision: 1 } }), attention("a3", { artifact: { title: "Web", url: "https://x.test/", revision: "1" } })]), feeds: [], fresh: [board], local: [board] })
  expect(result.entries.map((entry) => entry.key)).toEqual(["attention:opencode:a1", "attention:opencode:a2", "attention:opencode:a3"])
  expect(result.fresh.map((item) => item.id)).toEqual(["board-7"])
  expect(result.linked).toEqual([])
  expect(result.count).toBe(4)
})

test("several decisions on one Surface are listed inside its one item", () => {
  const board = surface("board-7", { revision: 7 })
  const result = needsYou({ items: local([attention("a1", { artifact: { title: "Board", surface: "board-7", revision: 7 } }), attention("a2", { artifact: { title: "Board", surface: "board-7", revision: 6 } })]), feeds: [], fresh: [board], local: [board] })
  expect(result.linked.map((item) => item.decisions.map((record) => record.id))).toEqual([["a1", "a2"]])
  expect(result.count).toBe(1)
})

test("another host's decision links only to that host's Surface and keeps the host in its key", () => {
  const mine = surface("board-7")
  const theirs = surface("board-7", { revision: 3 })
  const feeds = [feed("mini", "Mac Mini", { decisions: [attention("m1", { artifact: { title: "Board", surface: "board-7", revision: 3 } })], surfaces: [theirs] })]
  const result = needsYou({ items: [], feeds, fresh: [mine], local: [mine] })
  expect(result.linked.map((item) => [item.key, item.host, item.surface.revision, item.fresh])).toEqual([["mini~surface:board-7", "mini", 3, true]])
  expect(result.tries).toEqual([])
  expect(result.fresh.map((item) => item.id)).toEqual(["board-7"])
  expect(result.count).toBe(2)
})

test("a closed decision about a fresh Try rides on that Try as its outcome", () => {
  const board = surface("board-7", { revision: 7 })
  const answered = attention("a1", { status: "answered", updated_at: 2, artifact: { title: "Board", surface: "board-7", revision: 7 } })
  const result = needsYou({ items: [], feeds: [], fresh: [board], local: [board], closed: [answered] })
  expect(result.fresh.map((item) => item.id)).toEqual(["board-7"])
  expect(result.outcomes.get("surface:board-7")?.id).toBe("a1")
  expect(result.count).toBe(1)
})

test("a decision about an older revision says which one", () => {
  expect(staleArtifact(attention("a1", { artifact: { title: "Board", surface: "b", revision: 5 } }), surface("b", { revision: 7 }))).toBe("decision is about rev 5")
  expect(staleArtifact(attention("a1", { artifact: { title: "Board", surface: "b", revision: 7 } }), surface("b", { revision: 7 }))).toBeUndefined()
})

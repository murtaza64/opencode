import { expect, test } from "bun:test"
import { deskItems } from "./desk"
import type { HostFeed } from "./host-feed"
import { needsYou } from "./needs-you"
import { deliverables, type Surface } from "./surfaces"
import { workCountLabel, workQueue } from "./work-queue"

const attention = (id: string, extra = {}) =>
  ({ id, editspace: "opencode", revision: 1, status: "open", kind: "decision", title: `Decision ${id}`, options: [], delivery_state: "not-requested", created_at: 1, source_ref: { session_id: "ses_a", directory: "/r" }, ...extra }) as never
const feed = (id: string, label: string, state: Record<string, unknown>) =>
  ({ host: { id, label, origin: `http://127.0.0.1:${id === "mini" ? 1 : 2}` }, state: () => ({ status: "ready", rows: [], scoped: true, decisions: [], ...state }) }) as unknown as HostFeed
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
const fresh = deliverables([surface("new"), surface("seen", { seen: true }), surface("opened"), surface("board", { purpose: "board" })], new Set(["opened:1"])).fresh

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

test("nothing waiting anywhere is zero only when every host is current", () => {
  expect(needsYou({ items: [], feeds: [feed("mini", "Mac Mini", {})], fresh: [] }).label).toEqual({ text: "0", title: undefined })
})

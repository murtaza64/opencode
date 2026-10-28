import { expect, test } from "bun:test"
import { workCountLabel, workQueue } from "./work-queue"
import type { HostFeed } from "./host-feed"

const record = (id: string, created: number, extra = {}) => ({ id, editspace: "opencode", revision: 1, status: "open", kind: "decision", title: `Decision ${id}`, options: [], delivery_state: "not-requested", created_at: created, ...extra }) as never
const feed = (id: string, label: string, state: Record<string, unknown>) =>
  ({ host: { id, label, origin: `http://127.0.0.1:${id === "mini" ? 1 : 2}` }, state: () => ({ status: "ready", rows: [], scoped: true, decisions: [], ...state }) }) as unknown as HostFeed
const local = [{ key: "attention:opencode:11111111-1111-4111-8111-111111111111", kind: "decision", title: "Local decision", project: "opencode", revision: "1", checked: 1, source: { session: "ses_a", directory: "/r" } }] as never

test("this host's items come first; other Work hosts' decisions follow, each qualified by its host", () => {
  const queue = workQueue(local, [feed("mini", "Mac Mini", { decisions: [record("22222222-2222-4222-8222-222222222222", 2), record("11111111-1111-4111-8111-111111111111", 1)] })])
  expect(queue.entries.map((entry) => [entry.key, entry.host ?? "local", entry.href])).toEqual([
    ["attention:opencode:11111111-1111-4111-8111-111111111111", "local", "/?item=attention%3Aopencode%3A11111111-1111-4111-8111-111111111111"],
    // The same record ID on the Mini is a separate entry, opening on the Mini's own desk.
    ["mini~attention:opencode:11111111-1111-4111-8111-111111111111", "mini", "http://127.0.0.1:1/desk?item=attention%3Aopencode%3A11111111-1111-4111-8111-111111111111"],
    ["mini~attention:opencode:22222222-2222-4222-8222-222222222222", "mini", "http://127.0.0.1:1/desk?item=attention%3Aopencode%3A22222222-2222-4222-8222-222222222222"],
  ])
  expect(workCountLabel(queue)).toEqual({ text: "3", title: undefined })
})

test("an unreachable or not-current host keeps its last entries marked stale and makes the count partial, by name", () => {
  const queue = workQueue([], [
    feed("mini", "Mac Mini", { status: "unavailable", decisions: [record("22222222-2222-4222-8222-222222222222", 2)] }),
    feed("wing", "Wingman", { decisionsStale: true }),
  ])
  expect(queue.entries.map((entry) => [entry.host, entry.stale])).toEqual([["mini", true]])
  expect(workCountLabel(queue)).toEqual({ text: "1+", title: "Mac Mini, Wingman: not current" })
})

test("nothing anywhere is zero only when every host is current", () => {
  expect(workCountLabel(workQueue([], [feed("mini", "Mac Mini", {})]))).toEqual({ text: "0", title: undefined })
})

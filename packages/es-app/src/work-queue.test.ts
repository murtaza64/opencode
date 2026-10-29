import { expect, test } from "bun:test"
import { parseWorkKey, workCountLabel, workQueue, workSurfaces } from "./work-queue"
import type { HostFeed } from "./host-feed"

const UUID1 = "11111111-1111-4111-8111-111111111111"
const UUID2 = "22222222-2222-4222-8222-222222222222"
const record = (id: string, created: number, extra = {}) => ({ id, editspace: "opencode", revision: 1, status: "open", kind: "decision", title: `Decision ${id}`, options: [], delivery_state: "not-requested", created_at: created, ...extra }) as never
const request = (id: string, extra = {}) => ({ kind: "permission", id, session: "ses_m", directory: "/r", project: "opencode", title: "edit file", state: "pending", checked: 7, ...extra }) as never
const surface = (id: string, kind: "path" | "url", updated: number) => ({ id, title: `Surface ${id}`, summary: null, kind, owner: "x", lane: null, editspace: "opencode", updated_at: updated, revision: 1, health: { state: "ok" } }) as never
const feed = (id: string, label: string, state: Record<string, unknown>) =>
  ({ host: { id, label, origin: `http://127.0.0.1:${id === "mini" ? 1 : 2}` }, state: () => ({ status: "ready", rows: [], scoped: true, decisions: [], requests: [], surfaces: [], ...state }) }) as unknown as HostFeed
const local = [{ key: `attention:opencode:${UUID1}`, kind: "decision", title: "Local decision", project: "opencode", revision: "1", checked: 1, source: { session: "ses_a", directory: "/r" } }] as never

test("the same decision id on this host and another is two entries, each opening in this window's Work view", () => {
  const queue = workQueue(local, [feed("mini", "Mac Mini", { decisions: [record(UUID2, 2), record(UUID1, 1)] })])
  expect(queue.entries.map((entry) => [entry.key, entry.host ?? "local", entry.href])).toEqual([
    [`attention:opencode:${UUID1}`, "local", `/?item=attention%3Aopencode%3A${UUID1}`],
    [`mini~attention:opencode:${UUID1}`, "mini", `/?item=mini~attention%3Aopencode%3A${UUID1}`],
    [`mini~attention:opencode:${UUID2}`, "mini", `/?item=mini~attention%3Aopencode%3A${UUID2}`],
  ])
  // No entry opens another host's listener origin (which would switch the window to that host's tab).
  expect(queue.entries.every((entry) => entry.href.startsWith("/?item="))).toBe(true)
  expect(workCountLabel(queue)).toEqual({ text: "3", title: undefined })
})

test("another host's entry carries what its in-Work detail and actions need, on that host", () => {
  const queue = workQueue([], [feed("mini", "Mac Mini", { decisions: [record(UUID1, 5)], requests: [request("per_1")] })])
  expect(queue.entries.map((entry) => ({ key: entry.key, host: entry.host, kind: entry.kind, created: entry.created, updated: entry.updated, remote: entry.remote?.kind }))).toEqual([
    { key: `mini~attention:opencode:${UUID1}`, host: "mini", kind: "decision", created: 5, updated: undefined, remote: "attention" },
    { key: "mini~permission:/r:per_1", host: "mini", kind: "permission", created: undefined, updated: 7, remote: "request" },
  ])
  expect(parseWorkKey("mini~permission:/r:per_1")).toEqual({ host: "mini", key: "permission:/r:per_1" })
  expect(parseWorkKey(`attention:opencode:${UUID1}`)).toEqual({ key: `attention:opencode:${UUID1}` })
  expect(parseWorkKey("permission:/Users/m/~x:per_1")).toEqual({ key: "permission:/Users/m/~x:per_1" })
})

test("the same permission id on two hosts is two entries", () => {
  const queue = workQueue([], [feed("mini", "Mac Mini", { requests: [request("per_1")] }), feed("wing", "Wingman", { requests: [request("per_1")] })])
  expect(queue.entries.map((entry) => entry.key)).toEqual(["mini~permission:/r:per_1", "wing~permission:/r:per_1"])
})

test("an unreachable or not-current host keeps its last entries marked stale and makes the count partial, by name", () => {
  const queue = workQueue([], [
    feed("mini", "Mac Mini", { status: "unavailable", reason: "auth", since: 3, decisions: [record(UUID2, 2)] }),
    feed("wing", "Wingman", { decisionsStale: true }),
  ])
  expect(queue.entries.map((entry) => [entry.host, entry.stale, entry.unavailableReason])).toEqual([["mini", true, "auth"]])
  expect(workCountLabel(queue)).toEqual({ text: "1+", title: "Mac Mini, Wingman: not current" })
  expect(queue.hosts).toEqual([
    { id: "mini", label: "Mac Mini", status: "unavailable", reason: "auth", since: 3, partial: true },
    { id: "wing", label: "Wingman", status: "ready", partial: true },
  ])
})

test("a host whose pending requests cannot be read makes the count partial while its decisions stay current", () => {
  const queue = workQueue([], [feed("mini", "Mac Mini", { decisions: [record(UUID1, 1)], requestsStale: true })])
  expect(queue.entries.map((entry) => entry.stale)).toEqual([false])
  expect(workCountLabel(queue)).toEqual({ text: "1+", title: "Mac Mini: not current" })
})

test("a host not yet read is unknown, not zero", () => {
  expect(workCountLabel(workQueue([], [feed("mini", "Mac Mini", { status: "loading" })]))).toEqual({ text: "0+", title: "Mac Mini: not current" })
})

test("nothing anywhere is zero only when every host is current", () => {
  expect(workCountLabel(workQueue([], [feed("mini", "Mac Mini", {})]))).toEqual({ text: "0", title: undefined })
})

test("Surfaces of every Work host are one list: the same id on two hosts stays two, framed through its own host", () => {
  const surfaces = workSurfaces([surface("report", "path", 1)], [
    feed("mini", "Mac Mini", { surfaces: [surface("report", "path", 3), surface("board", "url", 9)] }),
    feed("wing", "Wingman", { status: "unavailable", surfaces: [surface("report", "path", 2)] }),
  ])
  expect(surfaces.entries.map((entry) => [entry.key, entry.href, entry.stale, entry.remote?.kind === "surface" ? entry.remote.frame : "local"])).toEqual([
    ["surface:report", "/?item=surface%3Areport", false, "local"],
    ["mini~surface:board", "/?item=mini~surface%3Aboard", false, "own-host-only"],
    ["mini~surface:report", "/?item=mini~surface%3Areport", false, "host"],
    ["wing~surface:report", "/?item=wing~surface%3Areport", true, "host"],
  ])
  expect(workCountLabel(surfaces)).toEqual({ text: "4+", title: "Wingman: not current" })
})

test("a host whose dashboard serves no Surfaces lists none and is not behind", () => {
  expect(workCountLabel(workSurfaces([], [feed("mini", "Mac Mini", { surfacesUnsupported: true })]))).toEqual({ text: "0", title: undefined })
})

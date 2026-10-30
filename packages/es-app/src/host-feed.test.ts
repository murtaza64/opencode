import { describe, expect, test } from "bun:test"
import type { GlobalSession } from "@opencode-ai/sdk/v2"
import { hostDecisionHref, hostRowKey, hostRows, hostSessionHref, hostTabHref, reachOf, reasonFor, workRows } from "./host-feed"
import { hostInfo, workFeedHosts } from "./host"

const session = (id: string, directory: string, updated: number, extra: Partial<GlobalSession> = {}) =>
  ({ id, title: `${id} title`, directory, time: { created: 1, updated }, ...extra }) as GlobalSession

describe("Work view rows", () => {
  test("another host's decision opens on that host's own Front desk with the record selected", () => {
    const mini = { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:65001" }
    expect(hostDecisionHref(mini, { editspace: "opencode", id: "11111111-1111-4111-8111-111111111111" }))
      .toBe("http://127.0.0.1:65001/desk?item=attention%3Aopencode%3A11111111-1111-4111-8111-111111111111")
  })

  test("this host's rows keep their plain key; another host's are host-qualified", () => {
    expect(hostRowKey({ id: "ses_a" })).toBe("ses_a")
    expect(hostRowKey({ id: "ses_a", host: "mini" })).toBe("mini:ses_a")
  })

  test("the same session ID on two hosts is listed twice, newest first", () => {
    const local = [{ id: "ses_same", title: "Laptop copy", directory: "/repo", updated: 10 }]
    const mini = hostRows("mini", [session("ses_same", "/repo", 20)])
    const rows = workRows(local, mini)
    expect(rows.map((row) => [row.host ?? "local", row.id])).toEqual([["mini", "ses_same"], ["local", "ses_same"]])
  })

  test("another host's rows carry its Core turn time; a session without one has none (never time.updated)", () => {
    const [timed, untimed] = hostRows("mini", [
      session("ses_t", "/repo", 999, { time: { created: 1, updated: 999, turn: { started: 100, ended: 150 } } }),
      session("ses_u", "/repo", 999),
    ])
    expect(timed!.turnAt).toBe(150)
    expect(untimed!.turnAt).toBeUndefined()
  })

  test("another host lists its unarchived root sessions, narrowed to its own project root", () => {
    const sessions = [
      session("ses_root", "/Users/m/opencode", 5),
      session("ses_lane", "/Users/m/opencode/.editspace/lanes/x/repos/a/b", 4),
      session("ses_other", "/Users/m/opencode-other", 3),
      session("ses_child", "/Users/m/opencode", 2, { parentID: "ses_root" }),
      session("ses_archived", "/Users/m/opencode", 1, { time: { created: 1, updated: 1, archived: 9 } }),
    ]
    expect(hostRows("mini", sessions, "/Users/m/opencode/.editspace").map((row) => row.id)).toEqual(["ses_root", "ses_lane"])
    expect(hostRows("mini", sessions).map((row) => row.id)).toEqual(["ses_root", "ses_lane", "ses_other"])
    expect(hostRows("mini", sessions).every((row) => row.host === "mini")).toBe(true)
  })

  test("another host's row carries when that host created the session", () => {
    expect(hostRows("mini", [session("ses_a", "/r", 9)]).map((row) => [row.id, row.created, row.updated])).toEqual([["ses_a", 1, 9]])
    expect(hostRows("mini", [session("ses_b", "/r", 9, { time: { updated: 9 } as GlobalSession["time"] })])[0]!.created).toBeUndefined()
  })

  test("opening another host's row reads it here; replying targets that host's own listener", () => {
    const mini = { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:60310" }
    expect(hostSessionHref(mini, { id: "ses_a", directory: "/a b" })).toBe("/session/ses_a?directory=%2Fa%20b&host=mini")
    expect(hostTabHref(mini, { id: "ses_a", directory: "/a b" })).toBe("http://127.0.0.1:60310/session/ses_a?directory=%2Fa%20b")
  })
})

describe("host info", () => {
  test("lists Work view hosts with valid ids and the new-work default", () => {
    const info = hostInfo({ id: "local", label: "Local", remote: false, hosts: [], work: [
      { id: "local", label: "Local", origin: "http://127.0.0.1:60302" },
      { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:60310/x", default: true },
      { id: "Bad Id", label: "x", origin: "http://127.0.0.1:1" },
      { id: "nolabel", origin: "http://127.0.0.1:2" },
    ] })
    expect(info.work).toEqual([
      { id: "local", label: "Local", origin: "http://127.0.0.1:60302" },
      { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:60310", default: true },
    ])
  })

  test("an older listener without a Work view reports none", () => {
    expect(hostInfo({ id: "local", label: "Local", remote: false, hosts: [] }).work).toEqual([])
    expect(hostInfo(undefined).work).toEqual([])
  })
})

describe("host reach", () => {
  test("sign-in needed is told apart from a failing server", () => {
    expect([401, 403, 302, 307].map(reasonFor)).toEqual(["auth", "auth", "auth", "auth"])
    expect([500, 502, 503, 404].map(reasonFor)).toEqual(["server", "server", "server", "server"])
  })

  test("a feed's state maps to the registry reach, keeping when the outage began and the last check", () => {
    expect(reachOf({ status: "loading" })).toEqual({ state: "unknown" })
    expect(reachOf({ status: "ready", checkedAt: 5 })).toEqual({ state: "reachable", checkedAt: 5 })
    expect(reachOf({ status: "unavailable", reason: "auth", since: 3, checkedAt: 9 }))
      .toEqual({ state: "unreachable", reason: "auth", since: 3, checkedAt: 9 })
  })
})

describe("Work feeds", () => {
  test("another Work host is a feed; this host and a Personal host never are", () => {
    const work = [
      { id: "laptop", label: "Laptop", origin: "http://127.0.0.1:1", profile: "work" as const },
      { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:2", profile: "work" as const },
      { id: "wing", label: "Wingman", origin: "http://127.0.0.1:3" },
      { id: "personal", label: "Personal", origin: "http://127.0.0.1:4", profile: "personal" as const },
    ]
    expect(workFeedHosts({ id: "laptop", work }).map((host) => host.id)).toEqual(["mini", "wing"])
  })
})

describe("host identity", () => {
  test("profile and kind are kept only when valid", () => {
    const info = hostInfo({ id: "laptop", label: "Laptop", profile: "work", kind: "laptop", hosts: [], work: [
      { id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:2", profile: "work", kind: "mini" },
      { id: "odd", label: "Odd", origin: "http://127.0.0.1:3", profile: "home", kind: "phone" },
    ] })
    expect(info).toMatchObject({ id: "laptop", profile: "work", kind: "laptop" })
    expect(info.work).toEqual([{ id: "mini", label: "Mac Mini", origin: "http://127.0.0.1:2", profile: "work", kind: "mini" }, { id: "odd", label: "Odd", origin: "http://127.0.0.1:3" }])
  })
})

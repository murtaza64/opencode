import { describe, expect, test } from "bun:test"
import { compareRows, turnClock, type LiveStatus, type TurnTime } from "./session-recency"

const row = (host: string, id: string, turn: TurnTime | undefined, status: LiveStatus, title = id) =>
  ({ clock: turnClock({ host, id, turn, status }), title })
const order = (rows: ReturnType<typeof row>[]) => [...rows].sort(compareRows).map((item) => item.clock.key)

describe("turnClock", () => {
  test("an open turn with busy status on its own host is active from its recorded start", () => {
    expect(turnClock({ host: "local", id: "ses_a", turn: { started: 1000, ended: 500 }, status: "busy" }))
      .toEqual({ key: "local:ses_a", recency: 1000, started: 1000, state: "active", live: true })
  })
  test("stream parts and tool updates leave the clock unchanged: only turn fields are read", () => {
    const before = turnClock({ host: "mini", id: "ses_a", turn: { started: 1000 }, status: "busy" })
    const afterParts = turnClock({ host: "mini", id: "ses_a", turn: { started: 1000 }, status: "busy" })
    expect(afterParts).toEqual(before)
  })
  test("the turn end closes it and becomes the recency", () => {
    expect(turnClock({ host: "local", id: "ses_a", turn: { started: 1000, ended: 4000 }, status: "idle" }))
      .toEqual({ key: "local:ses_a", recency: 4000, state: "ended", live: false })
  })
  test("an end in the same millisecond as the start closes the turn", () => {
    expect(turnClock({ host: "local", id: "ses_a", turn: { started: 1000, ended: 1000 }, status: "busy" }).state).toBe("ended")
  })
  test("a late end from an earlier turn does not close the current one", () => {
    expect(turnClock({ host: "local", id: "ses_a", turn: { started: 5000, ended: 4000 }, status: "busy" }).state).toBe("active")
  })
  test("a start never closed (crash) with an idle host is not running", () => {
    expect(turnClock({ host: "local", id: "ses_a", turn: { started: 1000 }, status: "idle" }))
      .toEqual({ key: "local:ses_a", recency: 1000, state: "unknown", live: false })
  })
  test("an offline or held host gives unknown status and never a running clock", () => {
    expect(turnClock({ host: "mini", id: "ses_a", turn: { started: 1000 }, status: "unknown" }).started).toBeUndefined()
  })
  test("busy without a recorded start is unknown, with no elapsed start", () => {
    expect(turnClock({ host: "local", id: "ses_a", turn: undefined, status: "busy" }))
      .toEqual({ key: "local:ses_a", recency: undefined, state: "unknown", live: true })
  })
  test("the same session ID on two hosts is two independent clocks", () => {
    const local = turnClock({ host: "local", id: "ses_same", turn: { started: 1000 }, status: "busy" })
    const mini = turnClock({ host: "mini", id: "ses_same", turn: { started: 900, ended: 2000 }, status: "idle" })
    expect([local.key, local.state, mini.key, mini.state]).toEqual(["local:ses_same", "active", "mini:ses_same", "ended"])
  })
  test("reload and streaming agree: the clock depends only on the session's durable turn fields and status", () => {
    const streamed = turnClock({ host: "local", id: "ses_a", turn: { started: 1000, ended: 3000 }, status: "idle" })
    const reloaded = turnClock({ host: "local", id: "ses_a", turn: { ended: 3000, started: 1000 }, status: "idle" })
    expect(reloaded).toEqual(streamed)
  })
})

describe("compareRows", () => {
  test("interleaved Local, Mini and Wingman rows: live first, then idle by turn boundary, newest first", () => {
    expect(order([
      row("local", "ses_1", { started: 1000, ended: 2000 }, "idle"),
      row("mini", "ses_2", { started: 3000 }, "busy"),
      row("wingman", "agt_3", { started: 500, ended: 2500 }, "idle"),
    ])).toEqual(["mini:ses_2", "wingman:agt_3", "local:ses_1"])
  })
  test("active rows sit above idle ones even without turn fields (older Core)", () => {
    expect(order([
      row("local", "ses_idle", { started: 9000, ended: 9500 }, "idle"),
      row("mini", "ses_busy_old", undefined, "busy", "zeta"),
    ])).toEqual(["mini:ses_busy_old", "local:ses_idle"])
  })
  test("adjacent active rows keep their order across part updates; one going idle drops below the still-active", () => {
    const active = [row("local", "ses_a", { started: 2000 }, "busy"), row("mini", "ses_b", { started: 1000 }, "busy"), row("local", "ses_c", undefined, "busy", "c")]
    expect(order(active)).toEqual(["local:ses_a", "mini:ses_b", "local:ses_c"])
    // Parts stream into every session: nothing in the clock changes, so neither does the order.
    expect(order([...active].reverse())).toEqual(["local:ses_a", "mini:ses_b", "local:ses_c"])
    const afterIdle = [row("local", "ses_a", { started: 2000, ended: 5000 }, "idle"), active[1]!, active[2]!]
    expect(order(afterIdle)).toEqual(["mini:ses_b", "local:ses_c", "local:ses_a"])
  })
  test("idle rows without turn fields (older Core) follow known idle rows in stable title order, never by time", () => {
    expect(order([
      row("mini", "ses_old_b", undefined, "idle", "beta"),
      row("local", "ses_new", { started: 10 }, "idle"),
      row("local", "ses_old_a", undefined, "idle", "alpha"),
    ])).toEqual(["local:ses_new", "local:ses_old_a", "mini:ses_old_b"])
  })
  test("equal recency ties break by host-qualified key", () => {
    expect(order([row("mini", "ses_a", { started: 10 }, "idle"), row("local", "ses_a", { started: 10 }, "idle")]))
      .toEqual(["local:ses_a", "mini:ses_a"])
  })
})

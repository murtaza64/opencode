import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Diagnostics } from "../src/diagnostics"
import { Global } from "../src/global"

afterEach(() => Diagnostics.stop())

describe("Diagnostics", () => {
  test("records nothing until started", () => {
    expect(Diagnostics.requestStart("/session/ses_123456789/message")).toBeUndefined()
    Diagnostics.sql("writer", "select 1", 5, 1)
    Diagnostics.start()
    const snapshot = Diagnostics.snapshot()
    expect(snapshot.sql.statements).toEqual([])
    expect(snapshot.requests.routes).toEqual([])
  })

  test("SQL aggregates keep statement shape but no literal values", () => {
    Diagnostics.start()
    Diagnostics.sql("writer", `select * from "message" where "data" = 'secret-token-value' and n = 42`, 3, 2)
    Diagnostics.sql("reader", `select "id" from "part" where "session_id" = ? limit ?`, 7, 50)
    const text = JSON.stringify(Diagnostics.snapshot().sql)
    expect(text).not.toContain("secret-token-value")
    expect(text).not.toContain("42")
    const keys = Diagnostics.snapshot().sql.statements.map((row) => row.key)
    expect(keys).toContain(`writer select * from "message" where "data" = '?' and n = ?`)
    expect(keys).toContain(`reader select "id" from "part" where "session_id" = ? limit ?`)
  })

  test("writer transactions are timed from begin to commit", () => {
    Diagnostics.start()
    Diagnostics.sql("writer", "BEGIN IMMEDIATE", 0, 0)
    Diagnostics.sql("writer", "insert into t values (?)", 1, 0)
    Diagnostics.sql("writer", "COMMIT", 1, 0)
    expect(Diagnostics.snapshot().sql.transactions.n).toBe(1)
  })

  test("statement table is capped and overflows into one other row", () => {
    Diagnostics.start()
    for (let i = 0; i < 500; i++) Diagnostics.sql("writer", `select "c${"x".repeat(i % 400)}" from "t${i}"`, 1, 0)
    const statements = Diagnostics.snapshot().sql.statements
    expect(statements.length).toBeLessThanOrEqual(40)
    // every statement is counted exactly once, including overflow
    expect(Diagnostics.snapshot().sql.statements.find((row) => row.key === "(other)")).toBeDefined()
  })

  test("routes aggregate identifier segments and report in-flight age", () => {
    Diagnostics.start()
    const open = Diagnostics.requestStart("/session/ses_e847071acffeddj4mKWTUPrHBw/message")
    const done = Diagnostics.requestStart("/session/ses_aaaaaaa1bbbbbbb/message")
    Diagnostics.requestEnd(done)
    const snapshot = Diagnostics.snapshot()
    expect(snapshot.requests.inflight).toBe(1)
    expect(snapshot.requests.oldestInflight[0]?.route).toBe("/session/:id/message")
    expect(snapshot.requests.routes.map((row) => row.key)).toEqual(["/session/:id/message"])
    expect(JSON.stringify(snapshot)).not.toContain("ses_e847071acffeddj4mKWTUPrHBw")
    Diagnostics.requestEnd(open)
    expect(Diagnostics.snapshot().requests.inflight).toBe(0)
  })

  test("a CPU profile is written privately, summarised, and only one runs at a time", async () => {
    Diagnostics.start()
    const first = Diagnostics.profile({ seconds: 1, label: "unit/../test" })
    await expect(Diagnostics.profile({ seconds: 1 })).rejects.toBeInstanceOf(Diagnostics.ProfileBusy)
    // Busy work during the capture so the sampler has JavaScript frames to record.
    await Bun.sleep(100)
    const until = performance.now() + 300
    while (performance.now() < until) JSON.stringify({ spin: Math.random() })
    const result = await first
    expect(path.dirname(result.file)).toBe(path.join(Global.Path.log, "profiles"))
    expect(path.basename(result.file)).toEndWith("-unittest.cpuprofile")
    expect((await fs.stat(result.file)).mode & 0o777).toBe(0o600)
    expect(result.summary.samples).toBeGreaterThan(0)
    expect(result.meta.pid).toBe(process.pid)
    expect(Diagnostics.snapshot().profiling).toBe(false)
  })

  test("profile duration is clamped", async () => {
    Diagnostics.start()
    const result = await Diagnostics.profile({ seconds: 0 })
    expect(result.seconds).toBe(Diagnostics.PROFILE_MIN_SECONDS)
  })

  test("the local token is stable, private, and checked exactly", async () => {
    const token = await Diagnostics.localToken()
    expect(await Diagnostics.localToken()).toBe(token)
    expect((await fs.stat(path.join(Global.Path.state, "diagnostics-token"))).mode & 0o777).toBe(0o600)
    expect(await Diagnostics.authorized(token)).toBe(true)
    expect(await Diagnostics.authorized(token.slice(1))).toBe(false)
    expect(await Diagnostics.authorized(undefined)).toBe(false)
  })

  test("a blocked loop is recorded with the request that was running", async () => {
    Diagnostics.start()
    await Bun.sleep(120)
    const id = Diagnostics.requestStart("/session/ses_123456789abc/message", "GET")
    const until = performance.now() + 300
    while (performance.now() < until) {}
    Diagnostics.requestEnd(id, { status: 200, bytes: 10 })
    await Bun.sleep(120)
    const stall = Diagnostics.recent().stalls.at(-1)
    expect(stall?.ms).toBeGreaterThanOrEqual(200)
    expect(stall?.routes).toContain("/session/:id/message")
  })

  test("slow requests are kept and appended to the local log without IDs", async () => {
    Diagnostics.start()
    const id = Diagnostics.requestStart("/session/ses_123456789abc/message", "GET", "/work/dir")
    await Bun.sleep(550)
    Diagnostics.requestEnd(id, { status: 200, bytes: 3_600_000 })
    expect(Diagnostics.recent().slowRequests.at(-1)).toMatchObject({
      type: "slow-request",
      method: "GET",
      route: "/session/:id/message",
      status: 200,
      bytes: 3_600_000,
      directory: "/work/dir",
    })
    await Diagnostics.flushLog()
    const lines = (await fs.readFile(Diagnostics.recent().logFile, "utf8")).trim().split("\n")
    expect(lines.some((line) => line.includes('"slow-request"') && line.includes("/session/:id/message"))).toBe(true)
    expect(lines.join("")).not.toContain("ses_123456789abc")
  })
})

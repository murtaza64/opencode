import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { childEnv, CODEX_APP_SERVER_PIN, readCodexUsage } from "./codex-quota"

const fake = path.join(import.meta.dir, "../test/fixtures/fake-codex-app-server.ts")
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const run = async (mode: string, timeoutMs = 5000) => {
  const dir = await mkdtemp(path.join(tmpdir(), "es-codex-quota-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const files = { log: path.join(dir, "sent.jsonl"), envLog: path.join(dir, "env.json"), helperPid: path.join(dir, "helper.pid") }
  const usage = await readCodexUsage({ command: [process.execPath, fake, JSON.stringify({ mode, ...files })], timeoutMs, now: () => 1793170000000 })
  const sent = (await readFile(files.log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
  return { usage, sent, files }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const gone = async (pid: number) => {
  for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50)
  return !alive(pid)
}

test("sends only the handshake and the two reads, with params omitted", async () => {
  const { sent } = await run("ok")
  expect(sent.map((message) => message.method)).toEqual(["initialize", "initialized", "account/rateLimits/read", "account/usage/read"])
  expect(sent[0].params).toEqual({ clientInfo: { name: "editspace_usage", title: "Editspace usage", version: "1" } })
  expect("capabilities" in sent[0].params).toBe(false)
  for (const read of sent.slice(2)) expect("params" in read).toBe(false)
})

test("quota windows keep only allowed fields: no account id, credit balance, upsell or reset credits", async () => {
  const { usage } = await run("ok")
  expect(usage.quota).toEqual({
    state: "ok",
    checkedAt: 1793170000000,
    buckets: [
      { limitId: "codex", limitName: null, primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1793200000 }, secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1793200000 }, planType: "pro", reached: null },
      { limitId: "codex_other", limitName: "Other", primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: 1793200000 }, secondary: null, planType: "pro", reached: null },
    ],
  })
  expect(JSON.stringify(usage)).not.toMatch(/acct_secret|12\.50|Upgrade|availableCount/)
  expect(usage.version).toBe("0.165.0")
  expect(usage.pinned).toBe(true)
  expect(CODEX_APP_SERVER_PIN.support).toContain("unsupported for production")
})

test("token activity is account-wide; missing values stay null, never zero", async () => {
  const ok = await run("ok")
  expect(ok.usage.tokenActivity).toEqual({ state: "ok", checkedAt: 1793170000000,
    summary: { lifetimeTokens: 1234567, peakDailyTokens: null, longestRunningTurnSec: 540, currentStreakDays: 8, longestStreakDays: null },
    daily: [{ startDate: "2026-10-27", tokens: 12345 }] })
  const nulls = await run("nulls")
  expect(nulls.usage.tokenActivity).toMatchObject({ state: "ok", daily: null, summary: { lifetimeTokens: null } })
})

test("API-key-only auth makes token activity unsupported while quota still reads", async () => {
  const { usage } = await run("api-key")
  expect(usage.tokenActivity).toEqual({ state: "unsupported", reason: "auth-unsupported", checkedAt: 1793170000000 })
  expect(usage.quota.state).toBe("ok")
})

test("a server-initiated request is refused and nothing is granted", async () => {
  const { usage, sent } = await run("server-request")
  expect(sent).toContainEqual({ id: 99, error: { code: -32601, message: "Not supported by this client" } })
  expect(sent.filter((message) => message.method).map((message) => message.method)).toEqual(["initialize", "initialized", "account/rateLimits/read", "account/usage/read"])
  expect(usage.quota.state).toBe("ok")
})

test("a malformed result is unavailable, not a number", async () => {
  const { usage } = await run("malformed")
  expect(usage.quota).toEqual({ state: "unavailable", reason: "invalid-response", checkedAt: 1793170000000 })
})

test("no CLI, no answer or another version are explicit states", async () => {
  expect((await readCodexUsage({ command: ["/nonexistent/codex"], now: () => 1 })).quota).toEqual({ state: "unavailable", reason: "not-installed", checkedAt: 1 })
  expect((await run("silent", 300)).usage.quota).toEqual({ state: "unavailable", reason: "timeout", checkedAt: 1793170000000 })
  const other = await run("other-version")
  expect([other.usage.version, other.usage.pinned]).toEqual(["0.170.0", false])
})

test("the CLI gets only PATH, HOME and an explicit CODEX_HOME: no desktop secrets or auth-switching variables", async () => {
  const canaries = { ES_CANARY_SECRET: "canary", BW_SESSION: "canary", GH_TOKEN: "canary", OPENAI_API_KEY: "canary", CODEX_API_KEY: "canary", CODEX_HOME: "/tmp/inherited" }
  const restore = Object.fromEntries(Object.keys(canaries).map((name) => [name, process.env[name]]))
  Object.assign(process.env, canaries)
  const inherited = await run("ok").finally(() => {
    for (const [name, value] of Object.entries(restore)) value === undefined ? delete process.env[name] : (process.env[name] = value)
  })
  expect(JSON.parse(await readFile(inherited.files.envLog, "utf8"))).toEqual({
    ES_CANARY_SECRET: false, BW_SESSION: false, GH_TOKEN: false, OPENAI_API_KEY: false, CODEX_API_KEY: false, CODEX_HOME: false, PATH: true, HOME: true,
  })
  expect(childEnv({ PATH: "/bin", HOME: "/h", LANG: "C", OPENAI_API_KEY: "x", CODEX_HOME: "/inherited" }, "/owner/codex")).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", CODEX_HOME: "/owner/codex" })
})

test("helpers the CLI started are stopped with it, after a normal read and after a timeout", async () => {
  const normal = await run("ok")
  expect(await gone(Number(await readFile(normal.files.helperPid, "utf8")))).toBe(true)
  const stuck = await run("silent", 300)
  expect(stuck.usage.quota).toMatchObject({ state: "unavailable", reason: "timeout" })
  expect(await gone(Number(await readFile(stuck.files.helperPid, "utf8")))).toBe(true)
})

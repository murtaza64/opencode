// A fake `codex app-server` speaking the stdio JSON-RPC shape of rust-v0.165.0, for codex-quota tests
// only. Its settings come as one JSON argument (the adapter passes the CLI a minimal environment):
// { mode, log, envLog, helperPid }; envLog records which canary variables arrived. It records every message it receives to `log`. No network, account
// or real CLI.
import { spawn } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"

const settings: { mode?: string; log?: string; envLog?: string; helperPid?: string } = JSON.parse(process.argv[2] ?? "{}")
const mode = settings.mode ?? "ok"
const log = settings.log
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const window = (used: number, mins: number) => ({ usedPercent: used, windowDurationMins: mins, resetsAt: 1793200000 })

const rateLimits = () => ({
  ordinaryUsageAllowed: true,
  accountId: "acct_secret",
  rateLimitUpsell: { title: "Upgrade" },
  rateLimitResetCredits: { availableCount: 2, credits: [{ id: "c1" }] },
  rateLimits: { limitId: "codex", limitName: null, primary: window(25, 300), secondary: window(41, 10080), credits: { hasCredits: true, unlimited: false, balance: "12.50" }, planType: "pro", rateLimitReachedType: null },
  rateLimitsByLimitId: {
    codex: { limitId: "codex", limitName: null, primary: window(25, 300), secondary: window(41, 10080), credits: { hasCredits: true, unlimited: false, balance: "12.50" }, planType: "pro", rateLimitReachedType: null },
    codex_other: { limitId: "codex_other", limitName: "Other", primary: window(5, 60), secondary: null, planType: "pro", rateLimitReachedType: null },
  },
})
const usage = () => ({
  summary: { lifetimeTokens: 1234567, peakDailyTokens: null, longestRunningTurnSec: 540, currentStreakDays: 8, longestStreakDays: null },
  dailyUsageBuckets: [{ startDate: "2026-10-27", tokens: 12345 }],
})

// Which of the test's canary variables reached it (true/false only, never a real environment dump), and a
// long-lived helper process like an MCP server.
const CANARIES = ["ES_CANARY_SECRET", "BW_SESSION", "GH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "PATH", "HOME"]
if (settings.envLog) writeFileSync(settings.envLog, JSON.stringify(Object.fromEntries(CANARIES.map((name) => [name, name in process.env]))))
if (settings.helperPid) {
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  writeFileSync(settings.helperPid, String(helper.pid))
}

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    if (log) appendFileSync(log, `${line}\n`)
    const message = JSON.parse(line)
    if (mode === "silent") continue
    if (message.method === "initialize") {
      if (mode === "server-request") send({ method: "item/permissions/requestApproval", id: 99, params: { permissions: ["network"] } })
      send({ id: message.id, result: { userAgent: mode === "other-version" ? "codex_cli_rs/0.170.0 (Mac OS)" : "codex_cli_rs/0.165.0 (Mac OS)", platformFamily: "unix", platformOs: "macos" } })
    }
    if (message.method === "account/rateLimits/read") {
      if (mode === "malformed") send({ id: message.id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: "25%" } } } })
      else send({ id: message.id, result: rateLimits() })
    }
    if (message.method === "account/usage/read") {
      if (mode === "api-key") send({ id: message.id, error: { code: -32600, message: "Token usage is not supported for API key authentication" } })
      else if (mode === "nulls") send({ id: message.id, result: { summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null } })
      else send({ id: message.id, result: usage() })
    }
  }
})

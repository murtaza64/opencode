/* Subscription quota windows and token activity for a ChatGPT/Codex plan, read through the user's own
 * local `codex app-server` (stdio JSON-RPC). A fixed whitelist: the initialize handshake, then
 * `account/rateLimits/read` and `account/usage/read` with params omitted. Nothing else is ever sent;
 * server-initiated requests are refused; results are schema-checked and reduced to allowed fields.
 * Nothing calls this yet: no caller, no flag on. No credential is read here; the CLI uses its own
 * sign-in. Quota windows, token activity, charges and API spend stay separate, and an unknown value is
 * a state, never 0. */
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

/** The protocol this adapter was written against. App-server is labelled experimental and not
 * supported for production (https://developers.openai.com/codex/app-server). */
export const CODEX_APP_SERVER_PIN = {
  release: "rust-v0.165.0",
  commit: "e374836b2728",
  accountSchemaBlob: "2de06c9edaf8",
  support: "experimental; unsupported for production",
} as const

export type Unknown = { state: "unavailable" | "unsupported"; reason: string; checkedAt: number }
export type Window = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export type QuotaBucket = { limitId: string; limitName: string | null; primary: Window | null; secondary: Window | null; planType: string | null; reached: string | null }
export type Quota = { state: "ok"; checkedAt: number; buckets: QuotaBucket[] } | Unknown
export type TokenActivity = {
  state: "ok"
  checkedAt: number
  /** Account-wide totals; each null when the service did not return it. */
  summary: { lifetimeTokens: number | null; peakDailyTokens: number | null; longestRunningTurnSec: number | null; currentStreakDays: number | null; longestStreakDays: number | null }
  /** Account-wide daily token counts, or null when not returned. Never attributable to a session or project. */
  daily: { startDate: string; tokens: number }[] | null
} | Unknown
/** `pinned: false` (another CLI version) means unverified: show it as experimental, never as authoritative. */
export type CodexUsage = { quota: Quota; tokenActivity: TokenActivity; version: string | null; pinned: boolean }

const DEFAULT_COMMAND = ["codex", "app-server", "--listen", "stdio://"]
const READS = { quota: "account/rateLimits/read", tokenActivity: "account/usage/read" } as const

/** One read of both views. `command` is the app-server command (tests pass a fake). */
/** `codexHome`: the owner-configured CODEX_HOME for the CLI, never taken from this process's environment. */
export const readCodexUsage = async (options: { command?: string[]; timeoutMs?: number; now?: () => number; codexHome?: string } = {}): Promise<CodexUsage> => {
  const now = options.now ?? Date.now
  const [file, ...args] = options.command ?? DEFAULT_COMMAND
  const replies = await session(file!, args, options.timeoutMs ?? 15_000, childEnv(process.env, options.codexHome))
  const checkedAt = now()
  if ("failure" in replies) {
    const unknown: Unknown = { state: "unavailable", reason: replies.failure, checkedAt }
    return { quota: unknown, tokenActivity: unknown, version: null, pinned: false }
  }
  const version = versionOf(replies.initialize)
  return {
    quota: replies.quota.ok ? quotaOf(replies.quota.result, checkedAt) : failed(replies.quota.error, checkedAt),
    tokenActivity: replies.tokenActivity.ok ? tokenActivityOf(replies.tokenActivity.result, checkedAt) : failed(replies.tokenActivity.error, checkedAt),
    version,
    pinned: version === CODEX_APP_SERVER_PIN.release.replace(/^rust-v/, ""),
  }
}

type Reply = { ok: true; result: unknown } | { ok: false; error: { code?: number; message?: string } }

const session = (file: string, args: string[], timeoutMs: number, env: Record<string, string>) =>
  new Promise<{ failure: string } | { initialize: unknown; quota: Reply; tokenActivity: Reply }>((resolve) => {
    // A minimal environment: no desktop secrets reach the CLI, and no OPENAI_API_KEY or other CODEX_*
    // setting can switch its auth mode. Its own process group, so helpers it starts are stopped with it.
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"], env, detached: true })
    const decoder = new StringDecoder("utf8")
    const pending = new Map<number, (reply: Reply) => void>()
    const state = { buffer: "", done: false }
    const finish = (value: Parameters<typeof resolve>[0]) => {
      if (state.done) return
      state.done = true
      clearTimeout(timer)
      child.stdin.end()
      stopGroup(child.pid)
      resolve(value)
    }
    const timer = setTimeout(() => finish({ failure: "timeout" }), timeoutMs)
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const call = (id: number, method: string, params?: Record<string, unknown>) =>
      new Promise<Reply>((settle) => {
        pending.set(id, settle)
        send(params ? { method, id, params } : { method, id })
      })
    child.on("error", (error: NodeJS.ErrnoException) => finish({ failure: error.code === "ENOENT" ? "not-installed" : "spawn-failed" }))
    child.on("exit", () => finish({ failure: "exited" }))
    child.stdin.on("error", () => finish({ failure: "exited" }))
    child.stdout.on("data", (chunk: Buffer) => {
      state.buffer += decoder.write(chunk)
      if (state.buffer.length > 4_000_000) return finish({ failure: "oversized" })
      const lines = state.buffer.split("\n")
      state.buffer = lines.pop() ?? ""
      for (const line of lines) {
        const message = parse(line)
        if (!message) continue
        // A server-initiated request (method + id) is refused; this adapter grants nothing.
        if (typeof message.method === "string" && message.id !== undefined) {
          send({ id: message.id, error: { code: -32601, message: "Not supported by this client" } })
          continue
        }
        if (typeof message.id !== "number") continue
        const settle = pending.get(message.id)
        if (!settle) continue
        pending.delete(message.id)
        settle(record(message.error) ? { ok: false, error: message.error as { code?: number; message?: string } } : { ok: true, result: message.result })
      }
    })
    void (async () => {
      const init = await call(0, "initialize", { clientInfo: { name: "editspace_usage", title: "Editspace usage", version: "1" } })
      if (!init.ok) return finish({ failure: "initialize-failed" })
      send({ method: "initialized", params: {} })
      const [quota, tokenActivity] = await Promise.all([call(1, READS.quota), call(2, READS.tokenActivity)])
      finish({ initialize: init.result, quota, tokenActivity })
    })()
  })

/** The only variables the CLI gets: PATH, HOME and LANG from this process, plus CODEX_HOME only when the
 * owner configured it explicitly. */
export const childEnv = (env: NodeJS.ProcessEnv, codexHome?: string): Record<string, string> => ({
  ...Object.fromEntries((["PATH", "HOME", "LANG"] as const).flatMap((name) => (env[name] ? [[name, env[name]!]] : []))),
  ...(codexHome ? { CODEX_HOME: codexHome } : {}),
})

// SIGTERM to our own process group, then SIGKILL after a short grace; never any other process.
const stopGroup = (pid: number | undefined) => {
  if (!pid) return
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name)
    } catch {
      // The group already exited.
    }
  }
  signal("SIGTERM")
  setTimeout(() => signal("SIGKILL"), 500).unref()
}

const parse = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// Auth that the token-activity service cannot use (API key only, Bedrock) is "unsupported".
const failed = (error: { code?: number; message?: string }, checkedAt: number): Unknown =>
  /api.?key|bedrock|not supported|unsupported/i.test(error.message ?? "")
    ? { state: "unsupported", reason: "auth-unsupported", checkedAt }
    : { state: "unavailable", reason: typeof error.code === "number" ? `rpc-${error.code}` : "rpc-error", checkedAt }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const int = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : undefined)
const nullableInt = (value: unknown) => (value === null || value === undefined ? null : int(value))
const label = (value: unknown) => (typeof value === "string" && value.length <= 64 && /^[\w .:-]*$/.test(value) ? value : null)

// `usedPercent` is an integer in the pinned schema (RateLimitWindow.used_percent: i32, rounded server-side).
const windowOf = (value: unknown): Window | null | undefined => {
  if (value === null || value === undefined) return null
  if (!record(value)) return undefined
  const used = int(value.usedPercent)
  const duration = nullableInt(value.windowDurationMins)
  const resets = nullableInt(value.resetsAt)
  if (used === undefined || used < 0 || duration === undefined || resets === undefined) return undefined
  return { usedPercent: used, windowDurationMins: duration, resetsAt: resets }
}

const bucketOf = (value: unknown): QuotaBucket | undefined => {
  if (!record(value)) return undefined
  const primary = windowOf(value.primary)
  const secondary = windowOf(value.secondary)
  const limitId = label(value.limitId)
  if (primary === undefined || secondary === undefined || !limitId) return undefined
  return { limitId, limitName: label(value.limitName), primary, secondary, planType: label(value.planType), reached: label(value.rateLimitReachedType) }
}

/** Allowed quota fields only (no account id, credit balance, upsell or reset-credit detail). */
export const quotaOf = (result: unknown, checkedAt: number): Quota => {
  if (!record(result)) return { state: "unavailable", reason: "invalid-response", checkedAt }
  const many = record(result.rateLimitsByLimitId) ? Object.values(result.rateLimitsByLimitId) : [result.rateLimits]
  const buckets = many.map(bucketOf)
  if (!buckets.length || buckets.some((bucket) => !bucket)) return { state: "unavailable", reason: "invalid-response", checkedAt }
  return { state: "ok", checkedAt, buckets: buckets as QuotaBucket[] }
}

/** Account-wide token activity; nullable fields stay null. */
export const tokenActivityOf = (result: unknown, checkedAt: number): TokenActivity => {
  if (!record(result) || !record(result.summary)) return { state: "unavailable", reason: "invalid-response", checkedAt }
  const s = result.summary
  const fields = ["lifetimeTokens", "peakDailyTokens", "longestRunningTurnSec", "currentStreakDays", "longestStreakDays"] as const
  const summary = Object.fromEntries(fields.map((name) => [name, nullableInt(s[name])]))
  if (Object.values(summary).some((value) => value === undefined)) return { state: "unavailable", reason: "invalid-response", checkedAt }
  const buckets = result.dailyUsageBuckets
  const daily = buckets === null || buckets === undefined ? null
    : Array.isArray(buckets) ? buckets.map((item) => record(item) && typeof item.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.startDate) && int(item.tokens) !== undefined && (item.tokens as number) >= 0
      ? { startDate: item.startDate, tokens: item.tokens as number } : undefined) : undefined
  if (daily === undefined || (daily && daily.some((item) => !item))) return { state: "unavailable", reason: "invalid-response", checkedAt }
  return { state: "ok", checkedAt, summary: summary as Extract<TokenActivity, { state: "ok" }>["summary"], daily: daily as { startDate: string; tokens: number }[] | null }
}

// The CLI version from initialize's user agent (e.g. "codex_cli_rs/0.165.0 ..."); null when absent.
const versionOf = (result: unknown) => {
  const agent = record(result) && typeof result.userAgent === "string" ? result.userAgent : ""
  return /\/(\d+\.\d+\.\d+)/.exec(agent)?.[1] ?? null
}

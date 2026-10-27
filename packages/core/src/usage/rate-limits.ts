export * as RateLimits from "./rate-limits"

/**
 * Latest provider-reported rate-limit state per provider, taken from headers already present on each model
 * response (`anthropic-ratelimit-*`, `anthropic-priority-*`, `anthropic-fast-*`, `x-ratelimit-*`, `retry-after`). No extra requests are made. Values are
 * counts, percentages and reset times; nothing else from the response is kept. Memory only: empty after a
 * restart until the next response.
 *
 * These are whatever limits the provider (or a gateway in front of it) chooses to report, typically per-minute
 * API limits. They are not provider billing and not necessarily a personal subscription's plan windows.
 */

// Documented families: Anthropic API rate-limit, Priority Tier and fast-mode headers; OpenAI x-ratelimit-*.
const PATTERN = /^(anthropic-ratelimit-|anthropic-priority-|anthropic-fast-|x-ratelimit-|retry-after$)/i
const MAX_HEADERS = 40
const MAX_VALUE = 100
const MAX_PROVIDERS = 32

type Snapshot = {
  provider: string
  observedAt: string
  headers: Record<string, string>
  requests?: Limit
  tokens?: Limit
  inputTokens?: Limit
  outputTokens?: Limit
}
type Limit = { limit?: number; remaining?: number; reset?: string }

const latest = new Map<string, Snapshot>()

/** Records the rate-limit headers of one response. Responses without any are ignored (the last snapshot stays). */
export function record(provider: string, headers: Record<string, string | undefined> | undefined, now = Date.now()) {
  if (!headers) return
  const kept = Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && PATTERN.test(entry[0]))
      .slice(0, MAX_HEADERS)
      .map(([name, value]) => [name.toLowerCase(), value.slice(0, MAX_VALUE)]),
  )
  if (Object.keys(kept).length === 0) return
  latest.delete(provider)
  latest.set(provider, {
    provider,
    observedAt: new Date(now).toISOString(),
    headers: kept,
    requests: limit(kept, "requests"),
    tokens: limit(kept, "tokens"),
    inputTokens: limit(kept, "input-tokens"),
    outputTokens: limit(kept, "output-tokens"),
  })
  if (latest.size > MAX_PROVIDERS) latest.delete(latest.keys().next().value!)
}

/** Latest snapshot per provider, labelled as provider-reported. */
export function snapshot() {
  return {
    source: "provider-reported rate limits from the latest model response headers; not billing or subscription quota",
    providers: [...latest.values()],
  }
}

/** Drops all snapshots (tests). */
export function clear() {
  latest.clear()
}

function limit(headers: Record<string, string>, kind: string): Limit | undefined {
  const read = (suffix: string) =>
    headers[`anthropic-ratelimit-${kind}-${suffix}`] ??
    headers[`x-ratelimit-${suffix}-${kind}`] ??
    headers[`x-ratelimit-${kind}-${suffix}`]
  const number = (value: string | undefined) => (value === undefined || !Number.isFinite(Number(value)) ? undefined : Number(value))
  const result = { limit: number(read("limit")), remaining: number(read("remaining")), reset: read("reset") }
  return result.limit === undefined && result.remaining === undefined && result.reset === undefined ? undefined : result
}

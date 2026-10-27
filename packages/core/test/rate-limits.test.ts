import { afterEach, describe, expect, test } from "bun:test"
import { RateLimits } from "../src/usage/rate-limits"

afterEach(() => RateLimits.clear())

describe("RateLimits", () => {
  test("keeps only rate-limit headers and parses Anthropic limits", () => {
    RateLimits.record(
      "anthropic",
      {
        "anthropic-ratelimit-requests-limit": "4000",
        "anthropic-ratelimit-requests-remaining": "3999",
        "anthropic-ratelimit-requests-reset": "2026-10-27T21:00:00Z",
        "anthropic-ratelimit-input-tokens-remaining": "1900000",
        "retry-after": "3",
        "anthropic-priority-input-tokens-remaining": "50000",
        authorization: "Bearer secret-value",
        "set-cookie": "session=secret-value",
        "request-id": "req_123",
      },
      Date.UTC(2026, 9, 27, 20),
    )
    const [snapshot] = RateLimits.snapshot().providers
    expect(snapshot).toMatchObject({
      provider: "anthropic",
      observedAt: "2026-10-27T20:00:00.000Z",
      requests: { limit: 4000, remaining: 3999, reset: "2026-10-27T21:00:00Z" },
      inputTokens: { remaining: 1900000 },
    })
    expect(Object.keys(snapshot!.headers).sort()).toEqual([
      "anthropic-priority-input-tokens-remaining",
      "anthropic-ratelimit-input-tokens-remaining",
      "anthropic-ratelimit-requests-limit",
      "anthropic-ratelimit-requests-remaining",
      "anthropic-ratelimit-requests-reset",
      "retry-after",
    ])
    expect(JSON.stringify(RateLimits.snapshot())).not.toContain("secret-value")
  })

  test("parses OpenAI-style limits and keeps the last snapshot when a response has none", () => {
    RateLimits.record("openai", { "x-ratelimit-limit-tokens": "30000", "x-ratelimit-remaining-tokens": "29000", "x-ratelimit-reset-tokens": "2s" })
    RateLimits.record("openai", { "content-type": "text/event-stream" })
    RateLimits.record("openai", undefined)
    expect(RateLimits.snapshot().providers).toMatchObject([
      { provider: "openai", tokens: { limit: 30000, remaining: 29000, reset: "2s" } },
    ])
  })
})

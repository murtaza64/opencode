import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RateLimits } from "@opencode-ai/core/usage/rate-limits"
import { Session } from "@/session/session"
import { provideTmpdirServer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(httpApiLayer, AppNodeBuilder.build(Session.node), AppNodeBuilder.build(CrossSpawnSpawner.node), TestLLMServer.layer),
)

type Daily = {
  estimate: true
  basis: string
  days: { day: string; cost: number | null; originOnly: boolean; models: { coverage: string; cost: number | null }[] }[]
  priceSource: { label: string }
  coverage: { origin: { basis: string } }
  rateLimits: { source: string; providers: { provider: string; requests?: { limit?: number; remaining?: number } }[] }
}

it.live(
  "daily usage reports estimated spend days and the provider's latest rate-limit headers after a turn",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          RateLimits.clear()
          yield* llm.text("done", { usage: { input: 120, output: 30 } })
          const session = yield* Session.use.create({ title: "Usage" })
          yield* requestInDirectory(`/session/${session.id}/prompt_async`, dir, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "hello" }],
            }),
          })
          const daily = yield* pollWithTimeout(
            Effect.gen(function* () {
              const response = yield* requestInDirectory("/experimental/usage/daily?days=3&offsetMinutes=0", dir)
              const body = (yield* response.json) as unknown as Daily
              return body.rateLimits.providers.length ? body : undefined
            }),
            "rate limits were not recorded",
            "10 seconds",
          )
          expect(daily.estimate).toBe(true)
          expect(daily.basis).toContain("not provider billing")
          expect(daily.days).toHaveLength(3)
          expect(daily.days[0]?.day).toBe(new Date().toISOString().slice(0, 10))
          expect(daily.rateLimits.source).toContain("not billing or subscription quota")
          expect(daily.priceSource.label).toContain("estimate")
          expect(daily.coverage.origin.basis).toContain("originating-host-only")
          expect(typeof daily.days[0]!.originOnly).toBe("boolean")
          const today = daily.days[0]!
          expect(today.models.every((model) => model.coverage !== "priced")).toBe(true)

          type Top = { estimate: true; sessions: { sessionID: string; title?: string; cost: number | null; unpricedTokens: number; tokens: { input: number; output: number } }[] }
          // The step's usage is projected when the step finishes, after its response headers were seen.
          const top = yield* pollWithTimeout(
            requestInDirectory("/experimental/usage/sessions?days=1&offsetMinutes=0", dir).pipe(
              Effect.flatMap((response) => response.json),
              Effect.map((body) => body as unknown as Top),
              Effect.map((body) => (body.sessions.some((item) => item.sessionID === session.id) ? body : undefined)),
            ),
            "session usage was not recorded",
            "10 seconds",
          )
          expect(top.estimate).toBe(true)
          const row = top.sessions.find((item) => item.sessionID === session.id)
          // The turn's usage is attributed to its session. The test provider is served on loopback, so it counts as
          // local (no API bill): cost 0, not unknown.
          expect(row).toMatchObject({ title: "Usage", cost: 0, unpricedTokens: 0, tokens: { input: 120, output: 30 } })
          expect(daily.rateLimits.providers).toMatchObject([{ provider: "test", requests: { limit: 500, remaining: 499 } }])
        }),
      { config: testProviderConfig },
    ),
  30_000,
)

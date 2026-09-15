import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpBody, HttpClient } from "effect/unstable/http"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { cliIt } from "../../lib/cli-process"
import { pollWithTimeout } from "../../lib/effect"

const freePort = Effect.sync(() => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
})

cliIt.live(
  "input receipts survive process restart without replaying uncertain provider work",
  ({ opencode, home, llm }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const env = {
        OPENCODE_DB: `${home}/input-restart.sqlite`,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`,
        OPENCODE_CONFIG: "",
        OPENCODE_CONFIG_DIR: `${home}/.config/opencode`,
        OPENCODE_PERMISSION: "{}",
        OPENCODE_EXPERIMENTAL: "false",
        OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
        OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
        OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
      }
      const first = yield* opencode.serve({ env, hostname: "127.0.0.1", port: yield* freePort })
      const post = (base: string, path: string, body: unknown) =>
        client.post(`${base}${path}`, { body: HttpBody.jsonUnsafe(body) })
      const created = yield* post(first.url, "/session", {
        title: "Restart receipts",
        agent: "build",
        model: { id: "test-model", providerID: "test" },
      })
      expect(created.status).toBe(200)
      const session = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.SessionInfo)))
      const url = `/session/${session.id}/input`
      const completedPayload = { requestID: "restart-completed", delivery: "queue", text: "complete this input" }
      yield* llm.text("completed input")
      expect((yield* post(first.url, url, completedPayload)).status).toBe(200)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* client.get(`${first.url}/session/${session.id}/message`)
          const messages = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
          )
          const failed = messages.find((m) => m.info.role === "assistant" && m.info.error)
          if (failed?.info.role === "assistant") throw new Error(`first input failed: ${failed.info.error?.name}`)
          return messages.some((m) => m.info.role === "assistant" && m.info.finish === "stop") ? true : undefined
        }),
        "first input did not finish",
        "15 seconds",
      )
      const completed = yield* (yield* client.get(`${first.url}${url}/restart-completed`)).json
      yield* llm.hang
      yield* post(first.url, url, { requestID: "restart-uncertain", delivery: "queue", text: "uncertain turn" })
      yield* llm.wait(2)
      const pendingPayload = { requestID: "restart-pending", delivery: "steer", text: "keep pending" }
      const pending = yield* (yield* post(first.url, url, pendingPayload)).json
      const cancelledPayload = { requestID: "restart-cancelled", delivery: "queue", text: "cancel this" }
      yield* post(first.url, url, cancelledPayload)
      const cancelled = yield* (yield* client.del(`${first.url}${url}/restart-cancelled`)).json
      first.kill()
      yield* Effect.promise(() => first.exited)

      const second = yield* opencode.serve({ env, hostname: "127.0.0.1", port: yield* freePort })
      expect(yield* (yield* client.get(`${second.url}${url}/restart-pending`)).json).toEqual(pending)
      expect(yield* (yield* post(second.url, url, completedPayload)).json).toEqual(completed)
      expect(yield* (yield* post(second.url, url, cancelledPayload)).json).toEqual(cancelled)
      expect(yield* (yield* post(second.url, url, pendingPayload)).json).toEqual(pending)
      expect((yield* post(second.url, url, { ...pendingPayload, delivery: "queue" })).status).toBe(409)
      const transcript = yield* client.get(`${second.url}/session/${session.id}/message`)
      expect(JSON.stringify(yield* transcript.json)).not.toContain("keep pending")
      expect(yield* llm.inputs).toHaveLength(2)
    }),
  60_000,
)

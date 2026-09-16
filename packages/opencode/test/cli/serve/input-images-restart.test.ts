import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpBody, HttpClient } from "effect/unstable/http"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { cliIt } from "../../lib/cli-process"
import { inputImage, imageProviderConfig } from "../../fixture/input-image"

const freePort = Effect.sync(() => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
})

cliIt.live(
  "pending images survive process restart and promote frozen bytes without renormalizing",
  ({ opencode, home, llm }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const image = yield* inputImage()
      const env = {
        OPENCODE_DB: `${home}/images.sqlite`,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: `${home}/managed`,
        OPENCODE_CONFIG: "",
        OPENCODE_CONFIG_DIR: `${home}/.config/opencode`,
        OPENCODE_PERMISSION: "{}",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(imageProviderConfig(llm.url)),
        OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false",
        OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
      }
      const first = yield* opencode.serve({ env, hostname: "127.0.0.1", port: yield* freePort })
      const post = (base: string, path: string, body: unknown) =>
        client.post(`${base}${path}`, { body: HttpBody.jsonUnsafe(body) })
      const created = yield* post(first.url, "/session", {
        title: "Frozen image restart",
        agent: "build",
        model: { id: "test-model", providerID: "test" },
      })
      const session = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionV1.SessionInfo)))
      const url = `/session/${session.id}`
      yield* llm.hang
      yield* post(first.url, `${url}/prompt_async`, {
        parts: [{ type: "text", text: "initial disposable work" }],
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
      })
      yield* llm.wait(1)
      const payload = { requestID: "restart-images", delivery: "queue", text: "", images: [image, image] }
      const admitted = yield* post(first.url, `${url}/input`, payload)
      expect(admitted.status).toBe(200)
      const receipt = yield* admitted.json
      yield* post(first.url, `${url}/input`, { ...payload, requestID: "cancelled-images" })
      expect((yield* client.del(`${first.url}${url}/input/cancelled-images`)).status).toBe(200)
      first.kill()
      yield* Effect.promise(() => first.exited)
      const second = yield* opencode.serve({
        hostname: "127.0.0.1",
        port: yield* freePort,
        env: {
          ...env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...imageProviderConfig(llm.url),
            attachment: { image: { auto_resize: false, max_base64_bytes: 1 } },
          }),
        },
      })
      expect(yield* (yield* post(second.url, `${url}/input`, payload)).json).toEqual(receipt)
      expect(yield* llm.inputs).toHaveLength(1)
      yield* llm.text("explicitly resumed")
      yield* llm.text("frozen images received")
      expect(
        (yield* post(second.url, `${url}/message`, {
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "explicit disposable continuation" }],
        })).status,
      ).toBe(200)
      const calls = yield* llm.inputs
      expect(calls).toHaveLength(3)
      expect(JSON.stringify(calls[2]).split(image.url)).toHaveLength(3)
      expect(yield* (yield* post(second.url, `${url}/input`, payload)).json).toMatchObject({
        state: "promoted",
        images: [image, image],
      })
      expect(yield* (yield* client.get(`${second.url}${url}/input/cancelled-images`)).json).toMatchObject({
        state: "cancelled",
      })
    }),
  60_000,
)

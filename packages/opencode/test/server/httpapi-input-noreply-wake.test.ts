import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionInput } from "@/session/input"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    httpApiLayer,
    AppNodeBuilder.build(Session.node),
    AppNodeBuilder.build(SessionInput.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    TestLLMServer.layer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const model = { providerID: "test", modelID: "test-model" }

const post = (dir: string, path: string, body: unknown) =>
  requestInDirectory(path, dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const json = (dir: string, path: string) => requestInDirectory(path, dir).pipe(Effect.flatMap((response) => response.json))

for (const delivery of ["queue", "steer"] as const) {
  it.live(
    `${delivery} mail on an idle session holding only noReply notes is promoted and answered by the advisory wake`,
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            yield* llm.text("answered the mail")
            const session = yield* Session.use.create({ title: "Notes then mail" })
            const note = yield* post(dir, `/session/${session.id}/prompt_async`, {
              agent: "build",
              model,
              noReply: true,
              parts: [{ type: "text", text: "a recorded note" }],
            })
            expect(note.status).toBe(204)
            yield* pollWithTimeout(
              json(dir, `/session/${session.id}/message`).pipe(
                Effect.map((messages) => ((messages as unknown[]).length === 1 ? true : undefined)),
              ),
              "note was not recorded",
            )

            const admitted = yield* post(dir, `/session/${session.id}/input`, {
              requestID: `mail-${delivery}`,
              delivery,
              text: "please look at this",
              source: { type: "editspace-mail", id: "lane#1", sender: "orchestrator", recipient: "work", kind: "task" },
            })
            expect(admitted.status).toBe(200)

            const answered = yield* pollWithTimeout(
              json(dir, `/session/${session.id}/message`).pipe(
                Effect.map((messages) => {
                  const list = messages as { info: { role: string; finish?: string } }[]
                  return list.some((m) => m.info.role === "assistant" && m.info.finish) ? list : undefined
                }),
              ),
              "queued mail was never promoted and answered",
              "30 seconds",
            )
            expect(answered.map((m) => m.info.role)).toEqual(["user", "user", "assistant"])
            const receipt = (yield* json(dir, `/session/${session.id}/input/mail-${delivery}`)) as { state: string }
            expect(receipt.state).not.toBe("pending")
          }),
        { config: testProviderConfig },
      ),
    60_000,
  )
}

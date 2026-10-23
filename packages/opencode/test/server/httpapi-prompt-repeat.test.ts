// A client that lost the answer to prompt_async may repeat it with the same message ID
// (es-app "Send again"). The repeat must not start another turn.
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionSupersession } from "@/session/supersession"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer, testInstanceStoreLayer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { ascending } from "@opencode-ai/schema/identifier"

const it = testEffect(Layer.mergeAll(httpApiLayer, AppNodeBuilder.build(LayerNode.group([Session.node, SessionPrompt.node, SessionRunState.node, SessionSupersession.node])), AppNodeBuilder.build(CrossSpawnSpawner.node), TestLLMServer.layer, testInstanceStoreLayer))

const body = (messageID: string, text: string) => ({
  messageID, agent: "build", model: { providerID: "test", modelID: "test-model" }, parts: [{ type: "text", text }],
})

it.live("a repeated prompt_async with the same message ID runs one turn; a new ID runs another", () =>
  provideTmpdirServer(({ dir, llm }) => Effect.gen(function* () {
    const first = `msg_${ascending()}`
    const second = `msg_${ascending()}`
    const session = yield* Session.use.create({ title: "Repeat" })
    const url = `/session/${session.id}`
    const post = (payload: unknown) => requestInDirectory(`${url}/prompt_async`, dir, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    })
    const transcript = () => requestInDirectory(`${url}/message`, dir).pipe(Effect.flatMap((response) => response.json)) as Effect.Effect<{ info: { id: string; role: string } }[]>
    const settled = (count: number) => pollWithTimeout(Effect.gen(function* () {
      const messages = yield* transcript()
      return messages.filter((message) => message.info.role === "assistant").length === count ? messages : undefined
    }), `expected ${count} assistant message(s)`, "10 seconds")

    yield* llm.text("first answer")
    expect((yield* post(body(first, "send once"))).status).toBe(204)
    yield* settled(1)
    expect((yield* post(body(first, "send once"))).status).toBe(204)
    yield* Effect.sleep("500 millis")
    const afterRepeat = yield* settled(1)
    expect(afterRepeat.filter((message) => message.info.id === first)).toHaveLength(1)

    yield* llm.text("second answer")
    expect((yield* post(body(second, "a new message"))).status).toBe(204)
    const final = yield* settled(2)
    // One user message per ID and one assistant turn per distinct ID: the repeat started no turn.
    expect(final.map((message) => message.info.role)).toEqual(["user", "assistant", "user", "assistant"])
  }), { config: testProviderConfig }), 30_000)

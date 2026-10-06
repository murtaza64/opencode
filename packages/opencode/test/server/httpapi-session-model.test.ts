import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { V1InputTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { provideTmpdirServer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(httpApiLayer, AppNodeBuilder.build(Session.node), AppNodeBuilder.build(Database.node), TestLLMServer.layer))

it.live("validated model PATCH freezes earlier inputs and preserves the active provider turn", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const held = Promise.withResolvers<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => held.resolve()))
        yield* llm.push(reply().text("first").wait(held.promise).stop())
        yield* llm.text("steer")
        yield* llm.text("queue")
        yield* llm.text("normal")
        const session = yield* Session.use.create({ title: "Model preference" })
        const path = `/session/${session.id}`
        const post = (suffix: string, body: unknown) =>
          requestInDirectory(`${path}/${suffix}`, dir, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        const patch = (body: unknown) =>
          requestInDirectory(path, dir, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        const model = { providerID: "test", modelID: "next-model" }
        expect((yield* post("prompt_async", {
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "original" }],
        })).status).toBe(204)
        yield* llm.wait(1)
        expect((yield* post("input", { requestID: "before", delivery: "queue", text: "queued before switch" })).status).toBe(200)
        expect((yield* patch({ model: { providerID: "test", modelID: "not-registered" } })).status).toBe(400)
        expect((yield* patch({ model: { ...model, variant: "nonexistent" } })).status).toBe(400)
        expect(yield* (yield* requestInDirectory(path, dir)).json).not.toHaveProperty("preferredModel")
        const changed = yield* patch({ model })
        expect(changed.status).toBe(200)
        expect(yield* changed.json).toMatchObject({ preferredModel: { id: "next-model", providerID: "test" } })
        expect(yield* (yield* requestInDirectory(path, dir)).json).toMatchObject({ preferredModel: { id: "next-model" } })
        expect((yield* post("input", { requestID: "after", delivery: "steer", text: "steer after switch" })).status).toBe(200)
        const db = yield* Database.Service
        const before = yield* db.db.select().from(V1InputTable).where(eq(V1InputTable.request_id, "before")).get()
        const after = yield* db.db.select().from(V1InputTable).where(eq(V1InputTable.request_id, "after")).get()
        expect(before?.model.modelID).toBe(ModelV2.ID.make("test-model"))
        expect(after?.model.modelID).toBe(ModelV2.ID.make("next-model"))
        expect(yield* llm.calls).toBe(1)
        held.resolve()
        yield* llm.wait(3)
        const messages = yield* pollWithTimeout(
          requestInDirectory(`${path}/message`, dir).pipe(
            Effect.flatMap((res) => res.json),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
            Effect.map((items) => items.filter((item) => item.info.role === "assistant").length >= 3 ? items : undefined),
          ),
          "mixed-model inputs did not drain",
          "10 seconds",
        )
        expect(messages.flatMap((item) => item.info.role === "assistant" ? [item.info.modelID] : [])).toEqual([
          ModelV2.ID.make("test-model"), ModelV2.ID.make("test-model"), ModelV2.ID.make("next-model"),
        ])
        expect(yield* (yield* post("input", { requestID: "before", delivery: "queue", text: "queued before switch" })).json)
          .toEqual(yield* (yield* requestInDirectory(`${path}/input/before`, dir)).json)
        expect((yield* post("prompt_async", { agent: "build", parts: [{ type: "text", text: "normal after switch" }] })).status).toBe(204)
        yield* llm.wait(4)
        const final = yield* pollWithTimeout(
          requestInDirectory(`${path}/message`, dir).pipe(
            Effect.flatMap((res) => res.json),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SessionV1.WithParts))),
            Effect.map((items) => items.filter((item) => item.info.role === "assistant").length >= 4 ? items : undefined),
          ),
          "normal Send did not complete",
          "10 seconds",
        )
        expect(final.flatMap((item) => item.info.role === "assistant" ? [item.info.modelID] : []).at(-1)).toBe(ModelV2.ID.make("next-model"))
      }),
    {
      config: (url) => {
        const base = testProviderConfig(url)
        return { ...base, provider: { test: { ...base.provider.test, models: {
          ...base.provider.test.models,
          "next-model": { ...base.provider.test.models["test-model"], id: "next-model", name: "Next Model" },
        } } } }
      },
    },
  ),
  20_000,
)

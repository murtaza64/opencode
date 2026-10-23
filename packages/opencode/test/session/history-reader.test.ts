import { afterAll, describe, expect } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseReader } from "@opencode-ai/core/database/reader"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// The runner reloads history through DatabaseReader (prompt.ts). These tests use a file database so the
// reader runs on real worker connections, and compare its reload to the writer's on the same data.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-history-reader-"))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const filename = path.join(dir, "history.sqlite")
const writer = Database.layerFromPath(filename)
const reader = DatabaseReader.layerFromPath({ filename }).pipe(Layer.provide(writer))
const layer = LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node, DatabaseReader.node]), [
  [Database.node, writer],
  [DatabaseReader.node, reader],
])
const it = testEffect(layer)

const user = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const id = MessageID.ascending()
    yield* session.updateMessage({
      id, sessionID, role: "user", time: { created: Date.now() }, agent: "test",
      model: { providerID: "test", modelID: "test" }, tools: {}, mode: "",
    } as unknown as SessionV1.Info)
    yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text })
    return id
  })

const assistant = (sessionID: SessionID, parentID: MessageID, tool: string) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const id = MessageID.ascending()
    yield* session.updateMessage({
      id, sessionID, parentID, role: "assistant", time: { created: Date.now() }, agent: "test", mode: "",
      modelID: "test", providerID: "test", path: { cwd: "/", root: "/" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as SessionV1.Info)
    yield* session.updatePart({
      id: PartID.ascending(), sessionID, messageID: id, type: "tool", callID: `call_${tool}`, tool,
      state: { status: "completed", input: { tool }, output: `${tool} output`, title: tool, metadata: {}, time: { start: 1, end: 2 } },
    } as unknown as SessionV1.Part)
    return id
  })

const both = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const writerDb = yield* Database.Service
    const readerDb = yield* DatabaseReader.Service
    return {
      writer: yield* MessageV2.filterCompactedEffect(sessionID).pipe(Effect.provideService(Database.Service, writerDb)),
      reader: yield* MessageV2.filterCompactedEffect(sessionID).pipe(Effect.provideService(Database.Service, readerDb)),
    }
  })

describe("runner history on reader workers", () => {
  it.instance("reload across several pages is identical to the writer's", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({})
        for (let i = 0; i < 70; i++) yield* assistant(created.id, yield* user(created.id, `turn ${i}`), `tool${i}`)
        return yield* both(created.id)
      })
      expect(result.reader.length).toBe(140)
      expect(JSON.stringify(result.reader)).toBe(JSON.stringify(result.writer))
    }),
  )

  it.instance("sees a just-projected assistant tool step and a steer before the next reload", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const created = yield* session.create({})
        const first = yield* user(created.id, "start")
        yield* both(created.id)
        const step = yield* assistant(created.id, first, "bash")
        const afterStep = yield* both(created.id)
        const steer = yield* user(created.id, "steer: also check logs")
        const afterSteer = yield* both(created.id)
        return { step, steer, afterStep, afterSteer }
      })
      const last = <T,>(items: readonly T[]) => items.at(-1)!
      expect(last(result.afterStep.reader).info.id).toBe(result.step)
      expect(last(result.afterStep.reader).parts.map((part) => part.type)).toEqual(["tool"])
      expect(last(result.afterSteer.reader).info.id).toBe(result.steer)
      expect(JSON.stringify(result.afterSteer.reader)).toBe(JSON.stringify(result.afterSteer.writer))
    }),
  )

  it.instance("latest user info matches the newest-first message search without hydrating parts", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      const empty = yield* MessageV2.latestInfo({ sessionID: created.id, role: "user" })
      let lastUser: MessageID | undefined
      for (let i = 0; i < 60; i++) {
        lastUser = yield* user(created.id, `turn ${i}`)
        yield* assistant(created.id, lastUser, `tool${i}`)
      }
      // newest message is an assistant: the search must skip it and return the newest user
      const latest = yield* MessageV2.latestInfo({ sessionID: created.id, role: "user" })
      const found = yield* session.findMessage(created.id, (m) => m.info.role === "user")
      expect(empty).toBeUndefined()
      expect(latest?.id).toBe(lastUser!)
      expect(found._tag === "Some" && JSON.stringify(found.value.info)).toBe(JSON.stringify(latest))
    }),
  )
})

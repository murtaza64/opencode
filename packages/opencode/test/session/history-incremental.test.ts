import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session as SessionNs } from "@/session/session"
import { SessionHistory } from "../../src/session/history"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])))

let clock = 1_000
const user = (sessionID: SessionID, text: string, extra?: Partial<SessionV1.Part>) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const id = MessageID.ascending()
    yield* session.updateMessage({
      id, sessionID, role: "user", time: { created: clock++ }, agent: "build",
      model: { providerID: "test", modelID: "test" }, tools: {}, mode: "",
    } as unknown as SessionV1.Info)
    const part = yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text, ...extra } as SessionV1.Part)
    return { id, part: part.id }
  })

const assistant = (sessionID: SessionID, parentID: MessageID, options: { summary?: boolean } = {}) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const id = MessageID.ascending()
    const info = {
      id, sessionID, parentID, role: "assistant", time: { created: clock++, completed: clock }, agent: "build", mode: "",
      modelID: "test", providerID: "test", path: { cwd: "/", root: "/" }, cost: 0, finish: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...(options.summary ? { summary: true } : {}),
    } as unknown as SessionV1.Info
    yield* session.updateMessage(info)
    const part = yield* session.updatePart({
      id: PartID.ascending(), sessionID, messageID: id, type: "tool", callID: `call_${id}`, tool: "bash",
      state: { status: "running", input: {}, title: "bash", metadata: {}, time: { start: 1 } },
    } as unknown as SessionV1.Part)
    return { id, part, info }
  })

const same = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const incremental = yield* SessionHistory.load(sessionID)
    const full = yield* MessageV2.filterCompactedEffect(sessionID)
    expect(JSON.stringify(incremental)).toBe(JSON.stringify(full))
    return incremental.length
  })

describe("incremental runner history", () => {
  it.instance("equals a full reload across appends, updates, removals and compaction", () =>
    Effect.gen(function* () {
      SessionHistory.clear()
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      const sessionID = created.id
      expect(yield* same(sessionID)).toBe(0)

      const first = yield* user(sessionID, "start")
      const step = yield* assistant(sessionID, first.id)
      yield* same(sessionID)
      expect(SessionHistory.stats()).toMatchObject({ scans: 1, advances: 1 })
      // a running tool settles: part update only
      yield* session.updatePart({ ...step.part, state: { ...(step.part as any).state, status: "completed", output: "done", time: { start: 1, end: 2 } } } as SessionV1.Part)
      yield* same(sessionID)
      // steer, then remove one of its parts and a whole message
      const steer = yield* user(sessionID, "steer")
      yield* same(sessionID)
      yield* session.removePart({ sessionID, messageID: steer.id, partID: steer.part })
      yield* same(sessionID)
      const extra = yield* assistant(sessionID, steer.id)
      yield* same(sessionID)
      yield* session.removeMessage({ sessionID, messageID: extra.id })
      yield* same(sessionID)
      // no change between loads
      yield* same(sessionID)
      expect(SessionHistory.stats()).toMatchObject({ scans: 1, hits: 1 })

      // compaction: the window is cut at the compaction user
      for (let i = 0; i < 3; i++) yield* assistant(sessionID, (yield* user(sessionID, `turn ${i}`)).id)
      const compaction = yield* user(sessionID, "compact", { type: "compaction", auto: true } as Partial<SessionV1.Part>)
      const summary = yield* assistant(sessionID, compaction.id, { summary: true })
      const cut = yield* same(sessionID)
      yield* assistant(sessionID, (yield* user(sessionID, "after")).id)
      expect(yield* same(sessionID)).toBe(cut + 2)
      // reverting the summary removes the boundary: the window must grow back to the whole session
      const before = SessionHistory.stats().scans
      yield* session.removeMessage({ sessionID, messageID: summary.id })
      expect(yield* same(sessionID)).toBeGreaterThan(cut + 2)
      expect(SessionHistory.stats().scans).toBe(before + 1)
      // an edit to a message older than the old boundary is visible
      yield* session.updatePart({ id: first.part, sessionID, messageID: first.id, type: "text", text: "edited" } as SessionV1.Part)
      yield* same(sessionID)
    }),
  )

  it.instance("a cold cache and a warm cache agree", () =>
    Effect.gen(function* () {
      SessionHistory.clear()
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      for (let i = 0; i < 60; i++) yield* assistant(created.id, (yield* user(created.id, `turn ${i}`)).id)
      const warm = yield* SessionHistory.load(created.id)
      SessionHistory.clear()
      const cold = yield* SessionHistory.load(created.id)
      expect(JSON.stringify(warm)).toBe(JSON.stringify(cold))
      expect(cold.length).toBe(120)
    }),
  )

  it.instance("newest matches Session.findMessage", () =>
    Effect.gen(function* () {
      SessionHistory.clear()
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      for (let i = 0; i < 70; i++) yield* assistant(created.id, (yield* user(created.id, `turn ${i}`)).id)
      yield* user(created.id, "trailing user")
      for (const predicate of [(m: SessionV1.WithParts) => m.info.role !== "user", (m: SessionV1.WithParts) => m.info.role === "user"]) {
        const cached = yield* SessionHistory.newest(created.id, predicate)
        const found = yield* session.findMessage(created.id, predicate)
        expect(JSON.stringify(cached?.found)).toBe(JSON.stringify(found._tag === "Some" ? found.value : undefined))
      }
    }),
  )
})

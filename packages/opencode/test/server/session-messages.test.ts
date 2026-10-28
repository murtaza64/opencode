import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"

import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(SessionNs.node), httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies SessionV1.TextPart)
        return id
      }),
  )
})

function request(path: string) {
  return TestInstance.pipe(Effect.flatMap((test) => requestInDirectory(path, test.directory)))
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as T))
}

describe("session messages endpoint", () => {
  it.instance(
    "optionally omits summary patches without changing history or stored messages",
    withoutWatcher(
      Effect.gen(function* () {
        const current = yield* sessionScoped
        yield* fill(current.id, 2)
        const session = yield* SessionNs.Service
        const id = MessageID.ascending()
        const patch = "+synthetic patch\n".repeat(10_000)
        yield* session.updateMessage({
          id,
          sessionID: current.id,
          role: "user",
          agent: "test",
          model,
          time: { created: Date.now() + 10 },
          summary: { diffs: [{ file: "fixture.ts", additions: 10, deletions: 2, status: "modified", patch }] },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: current.id,
          messageID: id,
          type: "text",
          text: "Keep the full visible message",
        })
        const full = yield* request(`/session/${current.id}/message`).pipe(Effect.flatMap(json<SessionV1.WithParts[]>))
        const slim = yield* request(`/session/${current.id}/message?summaryPatches=false`).pipe(
          Effect.flatMap(json<SessionV1.WithParts[]>),
        )
        expect(slim.map((item) => item.info.id)).toEqual(full.map((item) => item.info.id))
        expect(slim.map((item) => item.parts)).toEqual(full.map((item) => item.parts))
        expect(slim.at(-1)?.info).toMatchObject({
          summary: { diffs: [{ file: "fixture.ts", additions: 10, deletions: 2, status: "modified" }] },
        })
        expect(JSON.stringify(slim)).not.toContain("synthetic patch")
        expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(full).length / 10)
        const page = yield* request(`/session/${current.id}/message?limit=1&summaryPatches=false`)
        expect(page.headers["x-next-cursor"]).toBeTruthy()
        expect(page.headers.link).toContain("summaryPatches=false")
        expect(yield* page.json).toEqual(slim.slice(-1))
        const stored = yield* request(`/session/${current.id}/message/${id}`).pipe(
          Effect.flatMap(json<SessionV1.WithParts>),
        )
        expect(stored.info).toMatchObject({ summary: { diffs: [{ patch }] } })
      }),
    ),
    { git: true },
  )

  it.instance(
    "compact pages bound large tool output while the single-message route keeps it whole",
    withoutWatcher(
      Effect.gen(function* () {
        const current = yield* sessionScoped
        const [user] = yield* fill(current.id, 1)
        const session = yield* SessionNs.Service
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID: current.id,
          role: "assistant",
          parentID: user!,
          agent: "test",
          mode: "test",
          modelID: model.modelID,
          providerID: model.providerID,
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() + 10 },
        } satisfies SessionV1.Assistant)
        const output = `first-line\n${"x".repeat(50_000)}\nlast-line`
        const tool = (text: string) => ({
          id: PartID.ascending(),
          sessionID: current.id,
          messageID: id,
          type: "tool" as const,
          callID: PartID.ascending(),
          tool: "bash",
          state: {
            status: "completed" as const,
            input: { command: "build" },
            output: text,
            title: "build",
            metadata: { output: text, exit: 0 },
            time: { start: 1, end: 2 },
          },
        })
        yield* session.updatePart(tool(output))
        yield* session.updatePart(tool("short"))

        const page = yield* request(`/session/${current.id}/message?limit=10&compact=true`).pipe(
          Effect.flatMap(json<SessionV1.WithParts[]>),
        )
        const [large, small] = page.at(-1)!.parts.map((part) => (part.type === "tool" ? part.state : undefined))
        expect(large).toMatchObject({ status: "completed", metadata: { exit: 0, pageTruncated: { output: output.length } } })
        const text = large?.status === "completed" ? large.output : ""
        expect(text.startsWith("first-line")).toBe(true)
        expect(text.endsWith("last-line")).toBe(true)
        expect(text.length).toBeLessThan(9_000)
        expect(small).toMatchObject({ output: "short", metadata: { exit: 0, pageTruncated: { output: 5 } } })
        expect(JSON.stringify(page).length).toBeLessThan(20_000)

        const whole = yield* request(`/session/${current.id}/message/${id}`).pipe(Effect.flatMap(json<SessionV1.WithParts>))
        expect(whole.parts[0]?.type === "tool" && whole.parts[0].state.status === "completed" && whole.parts[0].state.output).toBe(output)
        const plain = yield* request(`/session/${current.id}/message?limit=10`).pipe(Effect.flatMap(json<SessionV1.WithParts[]>))
        expect(plain.at(-1)?.parts).toEqual(whole.parts)
      }),
    ),
    { git: true },
  )

  it.instance(
    "compact pages reference large tool attachments through an authorized route serving the exact bytes",
    withoutWatcher(
      Effect.gen(function* () {
        const current = yield* sessionScoped
        const [user] = yield* fill(current.id, 1)
        const session = yield* SessionNs.Service
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID: current.id,
          role: "assistant",
          parentID: user!,
          agent: "test",
          mode: "test",
          modelID: model.modelID,
          providerID: model.providerID,
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() + 10 },
        } satisfies SessionV1.Assistant)
        const png = Buffer.alloc(30_000, 7)
        const large = `data:image/png;base64,${png.toString("base64")}`
        const tiny = "data:image/png;base64,iVBORw0KGgo="
        const html = `data:text/html;base64,${Buffer.from("<script>alert(1)</script>".repeat(200)).toString("base64")}`
        const partID = PartID.ascending()
        const attachment = (url: string, mime: string) => ({ id: PartID.ascending(), sessionID: current.id, messageID: id, type: "file" as const, mime, url })
        yield* session.updatePart({
          id: partID,
          sessionID: current.id,
          messageID: id,
          type: "tool",
          callID: "call_shot",
          tool: "screenshot",
          state: {
            status: "completed",
            input: {},
            output: "captured",
            title: "screenshot",
            metadata: {},
            time: { start: 1, end: 2 },
            attachments: [attachment(large, "image/png"), attachment(tiny, "image/png"), attachment(html, "text/html")],
          },
        })

        const page = yield* request(`/session/${current.id}/message?limit=10&compact=true`).pipe(Effect.flatMap(json<SessionV1.WithParts[]>))
        const state = page.at(-1)!.parts[0]!.type === "tool" ? (page.at(-1)!.parts[0] as SessionV1.ToolPart).state : undefined
        const urls = state?.status === "completed" ? (state.attachments ?? []).map((file) => file.url) : []
        const path = `/session/${current.id}/message/${id}/part/${partID}/attachment/0`
        expect(urls).toEqual([path, tiny, `/session/${current.id}/message/${id}/part/${partID}/attachment/2`])
        expect(state?.status === "completed" && state.metadata).toMatchObject({ pageTruncated: { attachments: [{ index: 0 }, { index: 2 }] } })
        expect(JSON.stringify(page).length).toBeLessThan(10_000)

        const served = yield* request(path)
        expect(served.status).toBe(200)
        expect(served.headers["content-type"]).toBe("image/png")
        expect(Buffer.from(yield* served.arrayBuffer).equals(png)).toBe(true)
        const script = yield* request(`/session/${current.id}/message/${id}/part/${partID}/attachment/2`)
        expect(script.headers["content-type"]).toBe("application/octet-stream")
        expect(script.headers["x-content-type-options"]).toBe("nosniff")
        expect((yield* request(`/session/ses_other/message/${id}/part/${partID}/attachment/0`)).status).toBe(404)
        expect((yield* request(`/session/${current.id}/message/${id}/part/${partID}/attachment/9`)).status).toBe(404)

        const whole = yield* request(`/session/${current.id}/message/${id}`).pipe(Effect.flatMap(json<SessionV1.WithParts>))
        const wholeState = (whole.parts[0] as SessionV1.ToolPart).state
        expect(wholeState.status === "completed" && wholeState.attachments?.[0]?.url).toBe(large)
      }),
    ),
    { git: true },
  )

  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<SessionV1.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers["x-next-cursor"]
        expect(cursor).toBeTruthy()
        expect(a.headers["link"]).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<SessionV1.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body).toHaveLength(510)
      }),
    ),
    { git: true },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )
})

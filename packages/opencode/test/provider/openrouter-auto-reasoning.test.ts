import { describe, expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// Disposable fixtures for issue murtaza64/dotfiles#288: OpenRouter Auto routes each
// tool step to a possibly different upstream, and replaying encrypted reasoning
// minted by several upstreams in one request fails with HTTP 400.

const sessionID = SessionID.make("ses_auto_reasoning")
const providerID = ProviderV2.ID.make("openrouter")

function openrouterModel(id: string): Provider.Model {
  return {
    id: ModelV2.ID.make(id),
    providerID,
    api: { id, url: "https://openrouter.ai/api/v1", npm: "@openrouter/ai-sdk-provider" },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: { field: "reasoning_details" },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, input: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

const auto = openrouterModel("openrouter/auto")

const anthropic = (n: number) => ({
  type: "reasoning.text",
  text: `claude thinking ${n}`,
  signature: `sig-anthropic-${n}`,
  format: "anthropic-claude-v1",
  index: 0,
})
const openai = (n: number) => ({
  type: "reasoning.encrypted",
  data: `enc-openai-${n}`,
  id: `rs_${n}`,
  format: "openai-responses-v1",
  index: 0,
})

function part(messageID: string, id: string) {
  return { id: PartID.make(`prt_${id}`), sessionID, messageID: MessageID.make(messageID) }
}

function user(id: string, text: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID, modelID: auto.id },
    } as unknown as SessionV1.User,
    parts: [{ ...part(id, `${id}_text`), type: "text", text }] as SessionV1.Part[],
  }
}

// One persisted assistant step: signed/encrypted reasoning, visible text and one completed tool call.
function step(id: string, parentID: string, modelID: string, details: Array<Record<string, unknown>>) {
  const metadata = { openrouter: { reasoning_details: details } }
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "assistant",
      time: { created: 0 },
      parentID: MessageID.make(parentID),
      modelID,
      providerID,
      mode: "",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as SessionV1.Assistant,
    parts: [
      { ...part(id, `${id}_start`), type: "step-start" },
      { ...part(id, `${id}_reasoning`), type: "reasoning", text: `thinking ${id}`, time: { start: 0 }, metadata },
      { ...part(id, `${id}_text`), type: "text", text: `text ${id}` },
      {
        ...part(id, `${id}_tool`),
        type: "tool",
        tool: "bash",
        callID: `call_${id}`,
        metadata,
        state: {
          status: "completed",
          input: { command: `echo ${id}` },
          output: `out ${id}`,
          title: "bash",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
    ] as SessionV1.Part[],
  } satisfies SessionV1.WithParts
}

// Porter shape: earlier turn, then a current turn of four tool steps routed across two upstreams.
function history(modelID: string, details: Array<Array<Record<string, unknown>>>) {
  return [
    user("msg_001", "earlier question"),
    step("msg_002", "msg_001", modelID, [anthropic(0)]),
    user("msg_003", "current question"),
    ...details.map((item, index) => step(`msg_01${index}`, "msg_003", modelID, item)),
  ]
}

type Body = {
  messages: Array<{
    role: string
    content?: unknown
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    tool_call_id?: string
    reasoning_details?: Array<{ format?: string; signature?: string; data?: string; type: string }>
  }>
}

// Send the projection through the real OpenRouter SDK and capture the HTTP body it would post.
async function request(input: SessionV1.WithParts[], model: Provider.Model) {
  const bodies: Body[] = []
  const provider = createOpenRouter({
    apiKey: "test-key",
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        id: "gen-test",
        object: "chat.completion",
        created: 0,
        model: model.api.id,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }) as unknown as typeof fetch,
  })
  const messages = ProviderTransform.message(await MessageV2.toModelMessages(input, model), model, {})
  await generateText({ model: provider.chat(model.api.id), messages })
  return bodies[0]
}

const bound = (body: Body) =>
  body.messages.flatMap((msg) =>
    (msg.reasoning_details ?? []).filter((detail) => detail.type === "reasoning.encrypted" || detail.signature),
  )

const visible = (body: Body) =>
  body.messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    tool_calls: msg.tool_calls,
    tool_call_id: msg.tool_call_id,
  }))

describe("OpenRouter Auto reasoning projection", () => {
  test("does not send encrypted reasoning from more than one upstream provider", async () => {
    const input = history(auto.id, [[anthropic(1)], [openai(2)], [anthropic(3)], [anthropic(4)]])
    const before = structuredClone(input)
    const body = await request(input, auto)

    expect(new Set(bound(body).map((detail) => detail.format))).toEqual(new Set(["anthropic-claude-v1"]))
    // Same-provider current-turn signatures survive.
    expect(bound(body).map((detail) => detail.signature)).toEqual(
      expect.arrayContaining(["sig-anthropic-1", "sig-anthropic-3", "sig-anthropic-4"]),
    )
    // Persisted history is untouched.
    expect(input).toStrictEqual(before)
  })

  test("keeps the most recent upstream when Auto switches providers", async () => {
    const body = await request(history(auto.id, [[anthropic(1)], [anthropic(2)], [openai(3)], [openai(4)]]), auto)
    expect(bound(body).map((detail) => detail.data)).toEqual(["enc-openai-3", "enc-openai-4"])
  })

  test("preserves text, tool call IDs, arguments and results", async () => {
    const mixed = await request(history(auto.id, [[anthropic(1)], [openai(2)], [anthropic(3)], [openai(4)]]), auto)
    const single = await request(history(auto.id, [[openai(1)], [openai(2)], [openai(3)], [openai(4)]]), auto)
    expect(visible(mixed)).toStrictEqual(visible(single))
    const calls = mixed.messages.flatMap((msg) => msg.tool_calls ?? [])
    expect(calls.map((call) => [call.id, call.function.arguments])).toEqual(
      ["msg_002", "msg_010", "msg_011", "msg_012", "msg_013"].map((id) => [
        `call_${id}`,
        JSON.stringify({ command: `echo ${id}` }),
      ]),
    )
    expect(mixed.messages.filter((msg) => msg.role === "tool").map((msg) => msg.content)).toEqual(
      ["msg_002", "msg_010", "msg_011", "msg_012", "msg_013"].map((id) => `out ${id}`),
    )
  })

  test("leaves a fixed-model single-provider history unchanged", async () => {
    const fixed = openrouterModel("anthropic/claude-opus-4.5")
    const input = history(fixed.id, [[anthropic(1)], [anthropic(2)], [anthropic(3)], [anthropic(4)]])
    const body = await request(input, fixed)
    expect(bound(body).map((detail) => detail.signature)).toEqual([0, 1, 2, 3, 4].map((n) => `sig-anthropic-${n}`))
  })

  test("explicit model override drops prior provider-bound reasoning", async () => {
    const override = openrouterModel("openai/gpt-5")
    const body = await request(history(auto.id, [[anthropic(1)], [openai(2)]]), override)
    expect(bound(body)).toEqual([])
  })
})

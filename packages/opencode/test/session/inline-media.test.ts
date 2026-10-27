import { describe, expect, test } from "bun:test"
import { generateText, type ModelMessage } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { Provider } from "../../src/provider/provider"

// Media attached to a user message is stored as a data URL. The provider must receive exactly what it
// received before media were passed as base64 payloads, and the AI SDK must not download anything.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOM6rnEwMDAxAAGUAoAIIQBvq4LkJkAAAAASUVORK5CYII="
const model = { providerID: "test", id: "test", capabilities: { input: { image: true } } } as unknown as Provider.Model

const history = (): SessionV1.WithParts[] => {
  const sessionID = SessionID.make("ses_inline_media")
  const id = MessageID.ascending()
  return [
    {
      info: { id, sessionID, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "test" } },
      parts: [
        { id: PartID.ascending(), sessionID, messageID: id, type: "text", text: "look" },
        { id: PartID.ascending(), sessionID, messageID: id, type: "file", mime: "image/png", filename: "a.png", url: `data:image/png;base64,${png}` },
      ],
    } as unknown as SessionV1.WithParts,
  ]
}

const providerPrompt = async (messages: ModelMessage[]) => {
  let prompt: unknown
  const downloads: string[] = []
  await generateText({
    model: new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompt = options.prompt
        return { content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] } as never
      },
    }),
    messages,
    experimental_download: async (requests) => {
      downloads.push(...requests.map((request) => request.url.toString().slice(0, 30)))
      return requests.map(() => null)
    },
  })
  return { prompt, downloads }
}

describe("inline media for the model", () => {
  test("passes base64 with its media type instead of a data URL", async () => {
    const messages = await MessageV2.toModelMessages(history(), model)
    const file = (messages[0]!.content as Array<{ type: string; data?: unknown; mediaType?: string }>).find((part) => part.type === "file")
    expect(file).toMatchObject({ data: png, mediaType: "image/png" })
  })

  test("the provider receives the same prompt as with a data URL, without downloads", async () => {
    const inlined = await MessageV2.toModelMessages(history(), model)
    const asUrl = inlined.map((message) =>
      message.role !== "user" || !Array.isArray(message.content)
        ? message
        : { ...message, content: message.content.map((part) => (part.type === "file" ? { ...part, data: `data:${part.mediaType};base64,${part.data}` } : part)) },
    ) as ModelMessage[]
    const before = await providerPrompt(asUrl)
    const after = await providerPrompt(inlined)
    expect(before.downloads.length).toBe(1)
    expect(after.downloads).toEqual([])
    expect(JSON.stringify(after.prompt)).toBe(JSON.stringify(before.prompt))
  })
})

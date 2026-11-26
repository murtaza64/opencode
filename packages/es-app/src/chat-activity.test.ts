import { expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { chatDot, modelThinking } from "./chat-activity"

const assistant = (completed?: number) => ({ id: "msg_a", role: "assistant", sessionID: "ses", time: { created: 1, ...(completed ? { completed } : {}) } }) as unknown as Message
const reasoning = (end?: number) => ({ id: "r", type: "reasoning", text: "…", time: { start: 1, ...(end ? { end } : {}) } }) as unknown as Part
const text = (end?: number) => ({ id: "t", type: "text", text: "hi", time: { start: 2, ...(end ? { end } : {}) } }) as unknown as Part
const tool = (status: string) => ({ id: "c", type: "tool", tool: "bash", state: { status } }) as unknown as Part

test("the dot uses the sidebar's states: busy, idle, pending, failed, and unknown when no live status", () => {
  expect(["working", "retry", "idle", "waiting", "failed", "disconnected", "stale"].map((state) => chatDot(state as never).dot))
    .toEqual(["busy", "busy", "idle", "pending", "failed", "unknown", "unknown"])
  expect(chatDot("disconnected").label).toContain("unknown")
})

test("thinking only while a reasoning part streams with no running tool and no streaming text", () => {
  expect(modelThinking(assistant(), [reasoning()])).toBe(true)
  expect(modelThinking(assistant(), [reasoning(5)])).toBe(false)
  expect(modelThinking(assistant(), [reasoning(), tool("running")])).toBe(false)
  expect(modelThinking(assistant(), [reasoning(), tool("pending")])).toBe(false)
  expect(modelThinking(assistant(), [reasoning(), text()])).toBe(false)
  expect(modelThinking(assistant(), [reasoning(), text(3)])).toBe(true)
  expect(modelThinking(assistant(), [reasoning(), tool("completed")])).toBe(true)
})

test("a finished or missing message never thinks, whatever its parts say", () => {
  expect(modelThinking(assistant(9), [reasoning()])).toBe(false)
  expect(modelThinking(undefined, [reasoning()])).toBe(false)
  expect(modelThinking(assistant(), [])).toBe(false)
})

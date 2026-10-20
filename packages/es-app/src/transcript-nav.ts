import type { Message, Part } from "@opencode-ai/sdk/v2"
import { mailSourceID } from "./mail-timeline"

// A human prompt is identified by source, never by its prose: editspace mail
// carries structured source metadata, and generated inputs consist only of
// synthetic text parts. Both render as their own rows, not as prompts.
export const isUserPrompt = (message: Message, parts: readonly Part[]) =>
  message.role === "user" && !mailSourceID(message) &&
  !(parts.length && parts.every((part) => part.type === "text" && part.synthetic === true)) &&
  parts.some((part) => part.type === "file" || (part.type === "text" && !part.synthetic && !part.ignored && /\S/.test(part.text)))

// Positions are tops relative to the scroll container's visible top edge. A
// prompt within `slack` pixels of the edge counts as the current one.
export const promptTarget = (tops: readonly number[], direction: 1 | -1, slack = 30) =>
  direction === 1
    ? tops.findIndex((top) => top > slack)
    : tops.findLastIndex((top) => top < -slack)

export const promptPosition = (tops: readonly number[], slack = 30) => ({
  total: tops.length,
  current: tops.findLastIndex((top) => top <= slack),
  previous: promptTarget(tops, -1, slack) >= 0,
  next: promptTarget(tops, 1, slack) >= 0,
})

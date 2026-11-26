import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { DotState } from "./state"

// Chat activity above the composer (chat-activity-thinking-split-20261103). Two separate facts:
// - the overall dot, the same states and classes as the sidebar's dot, from the session's live status only;
// - thinking, from the model's own reasoning stream only (never from busy status, and busy never from thinking).

export type WorkState = "failed" | "disconnected" | "waiting" | "retry" | "working" | "stale" | "idle"

/** The sidebar dot for the chat's work state, and the words its label carries. */
export const chatDot = (state: WorkState): { dot: DotState; label: string } => ({
  working: { dot: "busy" as const, label: "Working" },
  retry: { dot: "busy" as const, label: "Retrying" },
  idle: { dot: "idle" as const, label: "Idle" },
  waiting: { dot: "pending" as const, label: "Waiting for your reply" },
  failed: { dot: "failed" as const, label: "Session failed" },
  disconnected: { dot: "unknown" as const, label: "Reconnecting: activity unknown" },
  stale: { dot: "unknown" as const, label: "Waiting for daemon: activity unknown" },
})[state]

/** The model is thinking: its latest assistant message is still open, a reasoning part is streaming, and no tool
 * call runs and no text streams. */
export const modelThinking = (message: Message | undefined, parts: readonly Part[]) => {
  if (!message || message.role !== "assistant" || message.time.completed) return false
  const reasoning = parts.some((part) => part.type === "reasoning" && part.time.end === undefined)
  const tool = parts.some((part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"))
  const text = parts.some((part) => part.type === "text" && !part.synthetic && part.time?.start !== undefined && part.time.end === undefined)
  return reasoning && !tool && !text
}

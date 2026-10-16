// Classifies the structured `source` on a user message. Only wire metadata decides
// provenance; message text can claim anything. Absent or `human` source is the
// interactive user and renders as an ordinary message.

export type SourceCategory = "agent" | "system"
export type SourcedInput = {
  type: "resume" | "heartbeat" | "subagent-return" | "handoff"
  category: SourceCategory
  label: string
  from: string
  headers: { name: string; value: string }[]
}

const text = (value: Record<string, unknown>, key: string) => {
  const item = value[key]
  return typeof item === "string" && item !== "" ? item : undefined
}

const headers = (entries: [string, string | undefined][]) =>
  entries.flatMap(([name, value]) => (value === undefined ? [] : [{ name, value }]))

/** Non-mail agent or system sources; mail keeps its dedicated renderer. */
export const sourcedInput = (message: { role: string; source?: unknown }): SourcedInput | undefined => {
  if (message.role !== "user" || !("source" in message)) return
  const source: unknown = message.source
  if (!source || typeof source !== "object" || !("type" in source)) return
  const value = source as Record<string, unknown>
  if (value.type === "resume") {
    const sender = text(value, "sender")
    if (!sender) return
    return {
      type: "resume",
      category: "agent",
      label: "Resume",
      from: sender,
      headers: headers([
        ["From", sender],
        ["From session", text(value, "senderSession")],
        ["Run", text(value, "originRun")],
        ["Reply to", text(value, "in_reply_to")],
      ]),
    }
  }
  if (value.type === "handoff") {
    const predecessor = text(value, "predecessor")
    if (!predecessor) return
    return {
      type: "handoff",
      category: "agent",
      label: "Handoff",
      from: text(value, "sender") ?? predecessor,
      headers: headers([
        ["From session", predecessor],
        ["From", text(value, "sender")],
        ["Lane", text(value, "lane")],
      ]),
    }
  }
  if (value.type === "subagent-return") {
    const sessionID = text(value, "sessionID")
    if (!sessionID) return
    return {
      type: "subagent-return",
      category: "agent",
      label: "Subagent",
      from: text(value, "agent") ?? sessionID,
      headers: headers([
        ["From session", sessionID],
        ["Agent", text(value, "agent")],
        ["Call", text(value, "callID")],
        ["Status", text(value, "status")],
      ]),
    }
  }
  if (value.type === "heartbeat") {
    const sender = text(value, "sender")
    if (!sender) return
    return {
      type: "heartbeat",
      category: "system",
      label: "Heartbeat",
      from: sender,
      headers: headers([
        ["From", sender],
        ["Schedule", text(value, "schedule")],
      ]),
    }
  }
}

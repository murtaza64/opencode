export type ActivityBriefInput = {
  sessionID: string
  status: "busy" | "idle" | "unknown"
  report?: { sessionID: string; owner: string; text: string; at: number }
  todos?: readonly { content: string; status: string }[]
  todoAt?: number
  tools?: readonly { name: string; status: string; sessionID?: string; at?: number }[]
}

export type ActivityBrief = {
  text: string
  source: "reported" | "todo" | "tool" | "status"
  at?: number
}

const line = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
const timestamp = (at: number | undefined, now: number) =>
  at !== undefined && Number.isFinite(at) && at > 0 && at <= now ? at : undefined

// Reports are advisory, never evidence of completion, attention, or execution ownership.
export const activityBrief = (input: ActivityBriefInput, now = Date.now()): ActivityBrief => {
  if (input.status !== "busy") return { text: input.status === "idle" ? "Idle" : "Activity unknown", source: "status" }
  const report = input.report
  const reportedAt = timestamp(report?.at, now)
  if (
    report &&
    input.sessionID &&
    report.owner === input.sessionID &&
    report.sessionID === input.sessionID &&
    reportedAt !== undefined &&
    now - reportedAt <= 300_000 &&
    line(report.text)
  ) {
    return { text: line(report.text), source: "reported", at: reportedAt }
  }
  const todo = input.todos?.find((todo) => todo.status === "in_progress" && line(todo.content))
  if (todo) return { text: line(todo.content), source: "todo", at: timestamp(input.todoAt, now) }
  // Tool titles/inputs can contain shell arguments or credentials. Only the protocol name is safe here.
  const tool = input.tools?.findLast(
    (tool) =>
      tool.status === "running" &&
      (!tool.sessionID || tool.sessionID === input.sessionID) &&
      /^[a-zA-Z][\w.-]{0,79}$/.test(tool.name),
  )
  if (tool) return { text: tool.name, source: "tool", at: timestamp(tool.at, now) }
  return { text: "Working", source: "status" }
}

export const activityBriefLabel = (brief: ActivityBrief, now = Date.now()) => {
  const age = brief.at === undefined ? undefined : Math.max(0, Math.floor((now - brief.at) / 1000))
  const source = brief.source === "todo" ? "TODO" : brief.source
  // An unknown age says nothing actionable, so nothing is shown (stale or disconnected states have their own line).
  if (age === undefined) return ""
  if (age < 60) return `${source} · ${age}s ago`
  if (age < 3600) return `${source} · ${Math.floor(age / 60)}m ago`
  if (age < 86400) return `${source} · ${Math.floor(age / 3600)}h ago`
  return `${source} · ${Math.floor(age / 86400)}d ago`
}

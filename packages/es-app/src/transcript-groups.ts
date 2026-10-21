import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { duration } from "./tool-magnitude"

// A run is a display-only block of adjacent tool calls in a completed agent
// turn. Raw history is never changed: members keep their message, part and call
// IDs and render as their original chips when the run is expanded.
export type ToolRunMember = { messageID: string; partID: string; callID: string }
export type ToolRunGroup = { key: string; members: ToolRunMember[] }
export type ToolRunPlan = { runs: Map<string, ToolRunGroup>; byPart: Map<string, string> }
export type Segment = { kind: "parts"; parts: Part[] } | { kind: "run"; key: string }

export const RUN_MIN = 2

type Row = { type: "transcript"; message: Message } | { type: "mail" }

// User message IDs whose agent turn (every assistant step answering that
// prompt) has finished. Mirrors the engine's completedTurn (session/run-state):
// a provider step with finish "tool-calls" or a set time.completed is only an
// intermediate step, and a final step that still holds client-executed tool
// calls needs continuation.
export const completedTurns = (messages: readonly Message[], input: {
  parts: (messageID: string) => readonly Part[]
  // The session has stopped working (no drain, retry or pending request).
  idle: boolean
  // A permission or question request still references this call.
  waiting: (messageID: string, callID: string) => boolean
}) => {
  const turns = new Map<string, Message[]>()
  let latest: string | undefined
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const steps = turns.get(message.parentID)
    if (steps) steps.push(message)
    else turns.set(message.parentID, [message])
    latest = message.parentID
  }
  const done = new Set<string>()
  for (const [parent, steps] of turns) {
    const settled = steps.every((step) => input.parts(step.id).every((part) =>
      part.type !== "tool" || (terminal(part) && !input.waiting(step.id, part.callID))))
    if (!settled) continue
    const last = steps.at(-1)!
    if (last.role !== "assistant") continue
    // A later step answering another prompt means this turn stopped.
    if (last.error || parent !== latest || (input.idle && last.time.completed) || finalStep(last, input.parts(last.id)))
      done.add(parent)
  }
  return done
}

const finalStep = (message: Extract<Message, { role: "assistant" }>, parts: readonly Part[]) => {
  if (message.structured !== undefined) return true
  if (!message.finish || message.finish === "tool-calls" || message.finish === "unknown") return false
  return !parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted)
}

const terminal = (part: ToolPart) => part.state.status === "completed" || part.state.status === "error"

export const planToolRuns = (rows: readonly Row[], input: {
  parts: (messageID: string) => readonly Part[]
  visible: (part: Part) => boolean
  // Parent (user message) IDs of completed turns; live turns never coalesce.
  completed: ReadonlySet<string>
  // Rendered between messages (turn summaries); a run never spans it.
  breakAfter?: (message: Message) => boolean
}): ToolRunPlan => {
  const runs = new Map<string, ToolRunGroup>()
  const byPart = new Map<string, string>()
  let current: ToolRunMember[] = []
  const flush = () => {
    if (current.length >= RUN_MIN) {
      const run = { key: `run:${current[0]!.messageID}:${current[0]!.partID}`, members: current }
      runs.set(run.key, run)
      current.forEach((member) => byPart.set(member.partID, run.key))
    }
    current = []
  }
  let parent: string | undefined
  for (const row of rows) {
    if (row.type !== "transcript" || row.message.role !== "assistant" || !input.completed.has(row.message.parentID)) {
      flush()
      parent = undefined
      continue
    }
    // A new parent is a new turn even when its user row is hidden from view.
    if (row.message.parentID !== parent) flush()
    parent = row.message.parentID
    for (const part of input.parts(row.message.id)) {
      if (!input.visible(part)) continue
      if (part.type !== "tool" || !terminal(part)) {
        flush()
        continue
      }
      current.push({ messageID: row.message.id, partID: part.id, callID: part.callID })
    }
    // A provider error renders after its message's parts.
    if (row.message.error || input.breakAfter?.(row.message)) flush()
  }
  flush()
  return { runs, byPart }
}

export type ToolOutcome = "ok" | "failed" | "interrupted" | "unfinished" | "unknown-exit"

// Shell calls finish as "completed" even with a nonzero exit code, and tools
// may report an error in metadata; both are failures. A null or non-numeric
// exit says nothing either way, so it is reported as unknown.
export const toolOutcome = (part: ToolPart): ToolOutcome => {
  const state = part.state
  if (state.status === "pending" || state.status === "running") return "unfinished"
  if (state.status === "error") return state.metadata?.interrupted === true ? "interrupted" : "failed"
  const metadata = state.metadata
  if (metadata?.error) return "failed"
  if (!metadata || !("exit" in metadata)) return "ok"
  if (typeof metadata.exit !== "number" || !Number.isFinite(metadata.exit)) return "unknown-exit"
  return metadata.exit === 0 ? "ok" : "failed"
}

// Collapsed-row facts: tool names/counts, wall-clock span and failure counts.
export const runSummary = (parts: readonly ToolPart[]) => {
  const counts = new Map<string, number>()
  parts.forEach((part) => counts.set(part.tool, (counts.get(part.tool) ?? 0) + 1))
  const outcomes = parts.map(toolOutcome)
  const count = (outcome: string) => outcomes.filter((item) => item === outcome).length
  // Parallel calls overlap, so the span is first start to last end, never a sum.
  const times = parts.flatMap((part) => {
    const state = part.state
    return (state.status === "completed" || state.status === "error") && Number.isFinite(state.time.start) && Number.isFinite(state.time.end) &&
      state.time.end >= state.time.start ? [state.time] : []
  })
  const untimed = parts.length - times.length
  const span = times.length ? duration(times.reduce((end, time) => Math.max(end, time.end), -Infinity) -
    times.reduce((start, time) => Math.min(start, time.start), Infinity)) : undefined
  return {
    tools: [...counts].map(([tool, total]) => total > 1 ? `${tool} ×${total}` : tool).join(" · "),
    // With untimed members the true span may be longer, so it is a lower bound.
    span: span && (untimed ? `≥${span}` : span),
    spanLabel: span && (untimed
      ? `At least ${span} wall clock: first start to last end of ${times.length} timed calls; ${untimed} without timing`
      : `${span} wall clock: first call start to last call end`),
    notes: [
      count("failed") && `${count("failed")} failed`,
      count("interrupted") && `${count("interrupted")} interrupted`,
      count("unfinished") && `${count("unfinished")} unfinished`,
      count("unknown-exit") && `${count("unknown-exit")} exit unknown`,
      untimed && `${untimed} untimed`,
    ].filter((note): note is string => !!note),
  }
}

// A run renders where its first member was; later members render inside it.
export const messageSegments = (parts: readonly Part[], plan: ToolRunPlan): Segment[] => {
  const segments: Segment[] = []
  for (const part of parts) {
    const key = plan.byPart.get(part.id)
    if (key) {
      if (plan.runs.get(key)?.members[0]?.partID === part.id) segments.push({ kind: "run", key })
      continue
    }
    const last = segments.at(-1)
    if (last?.kind === "parts") last.parts.push(part)
    else segments.push({ kind: "parts", parts: [part] })
  }
  return segments
}

export const samePlan = (a: ToolRunPlan, b: ToolRunPlan) => {
  if (a.runs.size !== b.runs.size || a.byPart.size !== b.byPart.size) return false
  for (const [key, run] of a.runs) {
    const other = b.runs.get(key)
    if (!other || other.members.length !== run.members.length) return false
    if (!run.members.every((member, index) => member.partID === other.members[index]!.partID)) return false
  }
  return true
}

export const sameSegments = (a: Segment[], b: Segment[]) =>
  a.length === b.length && a.every((segment, index) => {
    const other = b[index]!
    if (segment.kind === "run") return other.kind === "run" && other.key === segment.key
    return other.kind === "parts" && other.parts.length === segment.parts.length &&
      segment.parts.every((part, at) => part === other.parts[at])
  })

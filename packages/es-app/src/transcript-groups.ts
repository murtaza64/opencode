import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { toolMagnitude } from "./tool-magnitude"

// A run is a display-only block of consecutive small, finished tool calls. Raw
// history is never changed: members keep their message, part and call IDs and
// render as their original chips when the run is expanded.
export type ToolRunMember = { messageID: string; partID: string; callID: string }
export type ToolRun = { key: string; members: ToolRunMember[] }
export type ToolRunPlan = { runs: Map<string, ToolRun>; byPart: Map<string, string> }
export type Segment = { kind: "parts"; parts: Part[] } | { kind: "run"; key: string }

export const RUN_LIMITS = { min: 3, max: 40, rank: 1 }
// Tools whose result changes files, delegates work, asks the human or tracks
// TODOs stay visible as their own chips even when small.
const SIGNIFICANT_TOOLS = new Set(["task", "question", "todowrite", "todoread", "edit", "write", "patch", "apply_patch", "multiedit"])

type Row = { type: "transcript"; message: Message } | { type: "mail" }

export const planToolRuns = (rows: readonly Row[], input: {
  parts: (messageID: string) => readonly Part[]
  visible: (part: Part) => boolean
  // Rendered between messages (turn summaries); a run never spans it.
  breakAfter?: (message: Message) => boolean
}): ToolRunPlan => {
  const runs = new Map<string, ToolRun>()
  const byPart = new Map<string, string>()
  let current: ToolRunMember[] = []
  const flush = () => {
    if (current.length >= RUN_LIMITS.min) {
      const run = { key: `run:${current[0]!.messageID}:${current[0]!.partID}`, members: current }
      runs.set(run.key, run)
      current.forEach((member) => byPart.set(member.partID, run.key))
    }
    current = []
  }
  let parent: string | undefined
  for (const row of rows) {
    if (row.type !== "transcript" || row.message.role !== "assistant" || row.message.error) {
      flush()
      parent = undefined
      continue
    }
    // A new parent is a new turn even when its user row is hidden from view.
    if (row.message.parentID !== parent) flush()
    parent = row.message.parentID
    for (const part of input.parts(row.message.id)) {
      if (!input.visible(part)) continue
      if (!groupable(part)) {
        flush()
        continue
      }
      if (current.length >= RUN_LIMITS.max) flush()
      current.push({ messageID: row.message.id, partID: part.id, callID: part.callID })
    }
    if (input.breakAfter?.(row.message)) flush()
  }
  flush()
  return { runs, byPart }
}

// Grouping is by measured text size only; it never claims a call was safe or cheap.
export const groupable = (part: Part): part is ToolPart => {
  if (part.type !== "tool" || part.state.status !== "completed" || SIGNIFICANT_TOOLS.has(part.tool) || reportedFailure(part)) return false
  const magnitude = toolMagnitude(part)
  return magnitude.kind === "sized" && magnitude.rank <= RUN_LIMITS.rank && !magnitude.partial && !magnitude.attachments
}

// Shell calls finish as "completed" with a nonzero (or missing) exit code;
// tools may also report an error in metadata. Both are failures, kept visible.
const reportedFailure = (part: ToolPart) => {
  const metadata = part.state.status === "completed" ? part.state.metadata : undefined
  return !!metadata && (("exit" in metadata && metadata.exit !== 0) || !!metadata.error)
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

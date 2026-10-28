/* Pure projection of what the session page already holds (messages, parts, status, pending
 * requests) into the few facts the filament draws: one node per transcript item, the session
 * phase, and the deltas between two snapshots (text growth, tool completion). No fetches, no
 * timers; the component feeds it the store on each reactive update. */
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { sizeClass, toolMagnitude } from "../tool-magnitude"
import { commandKind, type CommandKind } from "./command-kind"

export type Phase = "idle" | "thinking" | "streaming" | "tool" | "delegated" | "waiting" | "error" | "complete" | "disconnected"
export type Node = {
  id: string
  // DOM lookup: user/assistant messages by message id, parts by part id, asks by request id.
  anchor: "message" | "part" | "ask"
  kind: "user" | "text" | "reasoning" | "tool" | "task" | "ask"
  messageID: string
  // Subagent-owned items (a running `task` tool) draw on a branch, keyed by the tool call.
  branch?: string
  status: "running" | "done" | "error" | "open"
  started?: number
  ended?: number
  length: number
  askKind?: "permission" | "question"
  // Tools: program family for bash and size ranks (0..4 = XS..XL) from tool-magnitude.
  tool?: string
  command?: CommandKind
  inputRank?: number
  outputRank?: number
}
// Prompt-cache continuity of one provider turn, from reported usage only (never from timing or
// turn index). `unknown` covers missing, zero-filled and unsupported telemetry.
export type CacheState = "unknown" | "warm" | "cold" | "mixed"
// `anchor` is the first drawable node of the step (what the seam sits above); a step with no
// drawable node yet (just started) has none and draws nothing.
export type Turn = { messageID: string; anchor?: string; cache: CacheState; read: number; write: number; input: number; settled: boolean }

export type Snapshot = {
  // One entry per assistant message (provider turn), in order; the seam before each is drawn from it.
  turns: Turn[]
  phase: Phase
  status: string
  nodes: Node[]
  waiting?: { id: string; kind: "permission" | "question" }
  branches: { id: string; alive: boolean; first: string; last: string }[]
  errors: number
}
export type Delta =
  | { type: "text"; id: string; kind: "text" | "reasoning"; grew: number }
  | { type: "tool.end"; id: string; status: "done" | "error" }
  | { type: "ask.open"; id: string }
  | { type: "ask.closed"; id: string }
  | { type: "phase"; from: Phase; to: Phase }
  | { type: "cache"; messageID: string; from: CacheState; to: CacheState }

export type StepPart = { id: string; type: "step-start" | "step-finish"; tokens?: { input?: number; cache?: { read?: number; write?: number } } }
export type Input = {
  messages: readonly Message[]
  parts: (messageID: string) => readonly Part[]
  // Provider-step parts, served apart from transcript parts (live.data.step). Absent = no seams.
  steps?: (messageID: string) => readonly StepPart[]
  status: string
  pending: readonly { kind: "permission" | "question"; request: { id: string } }[]
  subagents: number
  // Live link to the daemon; false = disconnected/stale: the picture must not claim work is happening.
  connected?: boolean
}

const toolStatus = (part: Extract<Part, { type: "tool" }>): Node["status"] =>
  part.state.status === "completed" ? "done" : part.state.status === "error" ? "error" : "running"

export const snapshot = (input: Input): Snapshot => {
  const nodes: Node[] = []
  const turns: Turn[] = []
  const branches = new Map<string, { id: string; alive: boolean; first: string; last: string }>()
  const busy = input.status === "busy" || input.status === "retry" || input.subagents > 0
  const lastMessage = input.messages[input.messages.length - 1]
  for (const message of input.messages) {
    // Only the newest message can still be streaming; older parts without an end time are history.
    const finished = message.role === "assistant" && message.time.completed !== undefined
    const open = (end: number | undefined) => !end && busy && message === lastMessage && !finished
    if (message.role === "user") {
      nodes.push({ id: message.id, anchor: "message", kind: "user", messageID: message.id, status: "done", length: 0 })
      continue
    }
    const first = nodes.length
    for (const part of input.parts(message.id)) {
      if (part.type === "text" && !part.synthetic) {
        nodes.push({ id: part.id, anchor: "part", kind: "text", messageID: message.id, status: open(part.time?.end) ? "running" : "done", started: part.time?.start, ended: part.time?.end, length: part.text.length })
      } else if (part.type === "reasoning") {
        nodes.push({ id: part.id, anchor: "part", kind: "reasoning", messageID: message.id, status: open(part.time?.end) ? "running" : "done", started: part.time?.start, ended: part.time?.end, length: part.text.length })
      } else if (part.type === "tool") {
        const status = toolStatus(part)
        const started = "time" in part.state ? part.state.time.start : undefined
        const ended = "time" in part.state && "end" in part.state.time ? part.state.time.end : undefined
        const kind = part.tool === "task" ? "task" : "tool"
        const mag = toolMagnitude(part)
        const input = part.state.status === "pending" ? undefined : (part.state.input as { command?: string } | undefined)
        nodes.push({
          id: part.id, anchor: "part", kind, messageID: message.id, status, started, ended, length: 0, tool: part.tool,
          command: part.tool === "bash" ? commandKind(input?.command) : undefined,
          inputRank: mag.kind === "sized" ? sizeClass(mag.input) : input ? sizeClass(JSON.stringify(input).length) : undefined,
          outputRank: mag.kind === "sized" ? sizeClass(mag.output) : undefined,
        })
        if (kind === "task") branches.set(part.id, { id: part.id, alive: status === "running", first: part.id, last: part.id })
      }
    }
    // Provider turns: step-start..step-finish pairs from live.data.step (ID order; a late finish
    // fills its start; an orphan finish is not placed). Part ids are time-ordered, so a step's
    // anchor is this message's first drawable node created after the step-start. No step parts =
    // no boundary (message.tokens holds only the last step).
    const mine = nodes.slice(first)
    let pendingStep: Turn | undefined
    // Pair by order of arrival rather than id: the store sorts step parts by id, and fixture ids
    // (or any non-ULID scheme) can sort a finish before its start.
    const stepParts = [...(input.steps?.(message.id) ?? [])]
    const starts = stepParts.filter((p) => p.type === "step-start")
    const finishes = stepParts.filter((p) => p.type === "step-finish")
    const ordered = starts.flatMap((start, i) => (finishes[i] ? [start, finishes[i]!] : [start]))
    for (const sp of ordered) {
      if (sp.type === "step-start") { pendingStep = { messageID: message.id, anchor: mine.find((n) => n.id > sp.id)?.id ?? mine[turns.filter((t) => t.messageID === message.id).length]?.id, cache: "unknown", read: 0, write: 0, input: 0, settled: false }; turns.push(pendingStep); continue }
      if (pendingStep) { Object.assign(pendingStep, cacheFrom(sp.tokens, true)); pendingStep = undefined }
    }
  }
  const waiting = input.pending[0]
  if (waiting) nodes.push({ id: waiting.request.id, anchor: "ask", kind: "ask", messageID: "", status: "open", length: 0, askKind: waiting.kind })
  const running = nodes.some((node) => node.kind === "tool" && node.status === "running")
  const delegated = nodes.some((node) => node.kind === "task" && node.status === "running")
  const streaming = nodes.some((node) => (node.kind === "text" || node.kind === "reasoning") && node.status === "running")
  const last = nodes[nodes.length - 1]
  // Order: a human request outranks everything; a lost link outranks any claim of activity; then the
  // most specific evidence (tool > delegated subagent > streaming text) before the catch-all thinking.
  const phase: Phase = waiting ? "waiting"
    : input.connected === false ? "disconnected"
    : input.status === "retry" ? "error"
    : !busy ? (last && last.kind !== "user" ? "complete" : "idle")
    : running ? "tool"
    : delegated ? "delegated"
    : streaming ? "streaming"
    : "thinking"
  return {
    turns,
    phase,
    status: input.status,
    nodes,
    waiting: waiting ? { id: waiting.request.id, kind: waiting.kind } : undefined,
    branches: [...branches.values()],
    errors: nodes.filter((node) => node.status === "error").length,
  }
}

// Usage can arrive after the turn completes: an unfinished message, or a finished one whose cache
// counts are all zero, is provisional (unknown). Only explicit cache telemetry is evidence: read
// alone = warm, write alone = cold (rebuild), read + write = mixed. Uncached input alone is NOT a
// miss (providers that report no cache fields look exactly like that), so it stays unknown.
const cacheFrom = (tokens: { input?: number; cache?: { read?: number; write?: number } } | undefined, settled: boolean) => {
  const read = tokens?.cache?.read ?? 0
  const write = tokens?.cache?.write ?? 0
  const uncached = tokens?.input ?? 0
  const cache: CacheState = read > 0 && write > 0 ? "mixed" : read > 0 ? "warm" : write > 0 ? "cold" : "unknown"
  return { cache, read, write, input: uncached, settled }
}

// Events between two snapshots; the scene turns each into one transient (pulse, flash, ring).
export const diff = (previous: Snapshot | undefined, next: Snapshot): Delta[] => {
  if (!previous) return []
  const out: Delta[] = []
  const before = new Map(previous.nodes.map((node) => [node.id, node] as const))
  for (const node of next.nodes) {
    const old = before.get(node.id)
    if ((node.kind === "text" || node.kind === "reasoning") && node.length > (old?.length ?? 0)) out.push({ type: "text", id: node.id, kind: node.kind, grew: node.length - (old?.length ?? 0) })
    if ((node.kind === "tool" || node.kind === "task") && old?.status === "running" && node.status !== "running") out.push({ type: "tool.end", id: node.id, status: node.status === "error" ? "error" : "done" })
    if (node.kind === "ask" && !old) out.push({ type: "ask.open", id: node.id })
  }
  for (const node of previous.nodes) if (node.kind === "ask" && !next.nodes.some((n) => n.id === node.id)) out.push({ type: "ask.closed", id: node.id })
  if (previous.phase !== next.phase) out.push({ type: "phase", from: previous.phase, to: next.phase })
  const was = new Map(previous.turns.map((t) => [t.messageID, t.cache] as const))
  for (const t of next.turns) { const old = was.get(t.messageID); if (old !== undefined && old !== t.cache) out.push({ type: "cache", messageID: t.messageID, from: old, to: t.cache }) }
  return out
}

// Human label for the static (reduced-motion) treatment and the HUD.
export const describe = (s: Snapshot, now: number) => {
  if (s.waiting) return s.waiting.kind === "permission" ? "Permission needed" : "Question for you"
  if (s.phase === "disconnected") return "Disconnected"
  if (s.phase === "delegated") return "Waiting on subagent"
  if (s.phase === "error") return "Retrying"
  const tool = s.nodes.findLast((node) => node.kind === "tool" && node.status === "running")
  if (tool) return `Running ${tool.id ? "tool" : ""}${tool.started ? ` · ${Math.round((now - tool.started) / 1000)}s` : ""}`
  if (s.phase === "streaming") return "Writing"
  if (s.phase === "thinking") return "Thinking"
  if (s.phase === "complete") return "Done"
  return "Idle"
}

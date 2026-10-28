/* Pure projection of what the session page already holds (messages, parts, status, pending
 * requests) into the few facts the filament draws: one node per transcript item, the session
 * phase, and the deltas between two snapshots (text growth, tool completion). No fetches, no
 * timers; the component feeds it the store on each reactive update. */
import type { Message, Part } from "@opencode-ai/sdk/v2"

export type Phase = "idle" | "thinking" | "streaming" | "tool" | "waiting" | "error" | "complete"
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
}
export type Snapshot = {
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

export type Input = {
  messages: readonly Message[]
  parts: (messageID: string) => readonly Part[]
  status: string
  pending: readonly { kind: "permission" | "question"; request: { id: string } }[]
  subagents: number
}

const toolStatus = (part: Extract<Part, { type: "tool" }>): Node["status"] =>
  part.state.status === "completed" ? "done" : part.state.status === "error" ? "error" : "running"

export const snapshot = (input: Input): Snapshot => {
  const nodes: Node[] = []
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
        nodes.push({ id: part.id, anchor: "part", kind, messageID: message.id, status, started, ended, length: 0 })
        if (kind === "task") branches.set(part.id, { id: part.id, alive: status === "running", first: part.id, last: part.id })
      }
    }
  }
  const waiting = input.pending[0]
  if (waiting) nodes.push({ id: waiting.request.id, anchor: "ask", kind: "ask", messageID: "", status: "open", length: 0, askKind: waiting.kind })
  const running = nodes.some((node) => node.kind !== "task" && node.kind === "tool" && node.status === "running")
  const streaming = nodes.some((node) => (node.kind === "text" || node.kind === "reasoning") && node.status === "running")
  const last = nodes[nodes.length - 1]
  const phase: Phase = waiting ? "waiting"
    : input.status === "retry" ? "error"
    : !busy ? (last && last.kind !== "user" ? "complete" : "idle")
    : running ? "tool"
    : streaming ? "streaming"
    : "thinking"
  return {
    phase,
    status: input.status,
    nodes,
    waiting: waiting ? { id: waiting.request.id, kind: waiting.kind } : undefined,
    branches: [...branches.values()],
    errors: nodes.filter((node) => node.status === "error").length,
  }
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
  return out
}

// Human label for the static (reduced-motion) treatment and the HUD.
export const describe = (s: Snapshot, now: number) => {
  if (s.waiting) return s.waiting.kind === "permission" ? "Permission needed" : "Question for you"
  if (s.phase === "error") return "Retrying"
  const tool = s.nodes.findLast((node) => node.kind === "tool" && node.status === "running")
  if (tool) return `Running ${tool.id ? "tool" : ""}${tool.started ? ` · ${Math.round((now - tool.started) / 1000)}s` : ""}`
  if (s.phase === "streaming") return "Writing"
  if (s.phase === "thinking") return "Thinking"
  if (s.phase === "complete") return "Done"
  return "Idle"
}

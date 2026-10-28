import type { Message } from "@opencode-ai/sdk/v2"

/** One passive-review wake recorded by the dashboard (`/es/api/wake-events`); `covers` is the frozen mail list. */
export type WakeEvent = { id: string; session: string; host?: string; cause: string; recipient?: string; at?: number | null
  admission?: string; outcome?: string; covers: string[] }

export type WakeMarker = {
  id: string
  /** woke: this input started a turn; joined: it arrived while a turn was running; unconfirmed: no turn observed. */
  state: "woke" | "joined" | "unconfirmed"
  label: string
  title: string
  covers: string[]
}

const CAUSES: Record<string, { woke: string; kind: string }> = {
  "passive-review": { woke: "Woke for passive review", kind: "Passive review" },
  resume: { woke: "Resumed", kind: "Resume" },
  recovery: { woke: "Recovered after restart", kind: "Recovery" },
  handoff: { woke: "Started from handoff", kind: "Handoff kickoff" },
  spawn: { woke: "Started from kickoff", kind: "Kickoff" },
}

/**
 * The timeline marker for an agent-side input that wakes a session (CHAT-PARTS §4), or undefined
 * for any other message. Wake is never read from text, admission or scheduling: only a reply
 * parented to this input shows it ran, and a turn still open when it arrived means it joined that
 * turn rather than starting one. Markers describe the wake only; the mail they cover keeps its own state.
 */
export const wakeMarker = (message: Message, messages: readonly Message[], events: ReadonlyMap<string, WakeEvent>): WakeMarker | undefined => {
  if (message.role !== "user" || !("source" in message)) return
  const source = message.source as { type?: unknown; id?: unknown; kind?: unknown } | undefined
  if (source?.type !== "editspace-mail" || typeof source.id !== "string" || typeof source.kind !== "string") return
  const cause = CAUSES[source.kind]
  if (!cause) return
  const event = events.get(source.id)
  const covers = source.kind === "passive-review" ? event?.covers ?? [] : []
  const count = covers.length ? ` · ${covers.length} mail` : ""
  const index = messages.findIndex((item) => item.id === message.id)
  const prior = messages.slice(0, Math.max(index, 0)).findLast((item) => item.role === "assistant")
  const replied = messages.some((item) => item.role === "assistant" && item.parentID === message.id)
  const running = prior?.role === "assistant" && (prior.time.completed === undefined || prior.time.completed > message.time.created)
  const state = !replied ? "unconfirmed" : running ? "joined" : "woke"
  const label = {
    woke: `${cause.woke}${count}`,
    joined: `${cause.kind} arrived while working${count}`,
    unconfirmed: `${cause.kind}${count} · wake not confirmed`,
  }[state]
  const outcome = { woke: "started a turn", joined: "joined the running turn", unconfirmed: "no reply observed" }[state]
  return { id: source.id, state, label, covers, title: `${new Date(event?.at ?? message.time.created).toLocaleString()} · ${outcome}` }
}

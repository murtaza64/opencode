import type { ContextPart } from "./api"
import type { SessionRow } from "./state"

// @ Add context (mention CONTRACT slice 1): agents and exact sessions. Adding context is local to
// one message: it never mails, notifies or asks anyone. Each item is identified by kind, host and
// id so the receiving agent can re-fetch it; the snapshot is bounded and never a whole history.

export const CONTEXT_MENTION_SOURCE = "es-app/mention"
// Free-text fields are clipped so a snapshot stays well under 2 KB and its reference line survives.
const clip = (value: string, limit = 300) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value

/** A lane's logical agent: the role that persists across handoffs, not one session. */
export type AgentCandidate = { editspace: string; lane: string; owner?: string; status?: string; activity?: string; title?: string; live?: string }

export type ContextRef =
  | { kind: "agent"; id: string; host: string; label: string; editspace: string; lane: string; owner?: string; status?: string; activity?: string; live?: string }
  | { kind: "session"; id: string; host: string; label: string; directory: string; updated: number; lane?: string; live?: string }

export type ContextGroup = { name: "Agents" | "Sessions"; items: ContextRef[] }

export const contextKey = (ref: Pick<ContextRef, "kind" | "host" | "id">) => `${ref.kind}:${ref.host}:${ref.id}`

/** Grouped picker rows, filtered client-side from already-loaded dashboard data (no reads per keystroke). */
export const contextGroups = (input: {
  query: string
  host: string
  agents: readonly AgentCandidate[]
  sessions: readonly SessionRow[]
  currentID: string
  laneOf: (sessionID: string) => string | undefined
  added: readonly ContextRef[]
}): ContextGroup[] => {
  const needle = input.query.toLocaleLowerCase()
  const added = new Set(input.added.map(contextKey))
  const score = (...fields: (string | undefined)[]) => {
    if (!needle) return 1
    const values = fields.flatMap((field) => field ? [field.toLocaleLowerCase()] : [])
    if (values[0]?.startsWith(needle)) return 3
    if (values[0]?.includes(needle)) return 2
    return values.slice(1).some((value) => value.includes(needle)) ? 1 : 0
  }
  const agents = input.agents
    .filter((agent) => agent.owner !== input.currentID)
    .map((agent) => ({ agent, score: score(agent.lane, agent.title, agent.activity) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(!!b.agent.live) - Number(!!a.agent.live) || a.agent.lane.localeCompare(b.agent.lane))
    .map(({ agent }): ContextRef => ({ kind: "agent", id: `${agent.editspace}/${agent.lane}`, host: input.host, label: agent.lane,
      editspace: agent.editspace, lane: agent.lane, owner: agent.owner, status: agent.status, activity: agent.activity, live: agent.live }))
    .filter((ref) => !added.has(contextKey(ref)))
    .slice(0, 6)
  const sessions = input.sessions
    .filter((row) => row.id !== input.currentID && !row.archived)
    .map((row) => ({ row, score: score(row.title, row.project, row.directory.split("/").filter(Boolean).at(-1)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.row.updated - a.row.updated)
    .map(({ row }): ContextRef => ({ kind: "session", id: row.id, host: input.host, label: row.title || row.id,
      directory: row.directory, updated: row.updated, lane: input.laneOf(row.id), live: row.live }))
    .filter((ref) => !added.has(contextKey(ref)))
    .slice(0, 8)
  return ([{ name: "Agents", items: agents }, { name: "Sessions", items: sessions }] as ContextGroup[]).filter((group) => group.items.length)
}

/** What adding this item attaches, stated before it is added. */
export const contextBound = (ref: ContextRef) => ref.kind === "agent"
  ? "Adds: agent identity (lane, current session, status, activity) and link. Not the transcript."
  : "Adds: exact session (title, lane, last updated) and link. Not the transcript."

/** Replaces `@query` with a readable `@Label ` so the sentence still reads; the chip carries the context. */
export const insertContextLabel = (text: string, start: number, caret: number, label: string) => {
  const inserted = `@${label.replace(/\s+/g, " ").trim()} `
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length }
}

/** The bounded, source-linked snapshot one chip sends as a synthetic context part. */
export const contextPart = (ref: ContextRef, url: string, asOf: number): ContextPart => {
  const record = { kind: ref.kind, id: ref.id, host: ref.host, asOf: new Date(asOf).toISOString(), url }
  const lines = ref.kind === "agent"
    ? [`Context the person attached (a reference, not a request to contact anyone): agent for lane ${ref.lane} in editspace ${ref.editspace} on host ${ref.host}.`,
      ref.owner ? `Current session: ${ref.owner}` : "Current session: none recorded",
      ref.status ? `Status: ${clip(ref.status, 40)}` : "", ref.activity ? `Activity: ${clip(ref.activity)}` : ""]
    : [`Context the person attached (a reference, not a request to contact anyone): session ${ref.id} "${clip(ref.label, 200)}" on host ${ref.host}.`,
      ref.lane ? `Lane: ${ref.lane}` : "", `Last updated: ${new Date(ref.updated).toISOString()}`, `Directory: ${clip(ref.directory)}`]
  const text = [...lines.filter(Boolean), `Link: ${url}`, `Reference: ${JSON.stringify(record)}`].join("\n")
  return { type: "text", text, synthetic: true,
    metadata: { source: CONTEXT_MENTION_SOURCE, key: contextKey(ref) } }
}

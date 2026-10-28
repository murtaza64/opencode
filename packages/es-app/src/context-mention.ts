import type { ContextPart } from "./api"
import type { AttentionRecord } from "./attention"
import type { SessionRow } from "./state"
import type { Surface } from "./surfaces"

// @ Add context (mention CONTRACT slices 1-2): agents, exact sessions, open decisions and surfaces.
// Adding context is local to one message: it never mails, notifies or asks anyone. Each item is
// identified by kind, host and id so the receiving agent can re-fetch it; the snapshot is bounded
// (at most SNAPSHOT_BYTES of UTF-8) and never a whole history.

export const CONTEXT_MENTION_SOURCE = "es-app/mention"
// Free-text fields are clipped so a snapshot stays well under 2 KB and its reference line survives.
const clip = (value: string, limit = 300) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value
export const SNAPSHOT_BYTES = 2048
// Matches the input contract's per-message context limit.
export const MAX_CONTEXT = 8
const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).length
// Clips to a UTF-8 byte budget on a code point boundary.
const fitBytes = (value: string, budget: number) => {
  if (bytes(value) <= budget) return value
  // "…" is 3 bytes.
  const points = Array.from(value)
  const sizes = points.map(bytes)
  const count = sizes.reduce((acc, size) => acc.used + size + 3 <= budget && acc.count === acc.index ? { used: acc.used + size, count: acc.count + 1, index: acc.index + 1 } : { ...acc, index: acc.index + 1 }, { used: 0, count: 0, index: 0 }).count
  return `${points.slice(0, count).join("")}…`
}

/** A lane's logical agent: the role that persists across handoffs, not one session. */
export type AgentCandidate = { editspace: string; lane: string; owner?: string; status?: string; activity?: string; title?: string; live?: string }

export type ContextRef =
  | { kind: "agent"; id: string; host: string; label: string; editspace: string; lane: string; owner?: string; status?: string; activity?: string; live?: string }
  | { kind: "session"; id: string; host: string; label: string; directory: string; updated: number; lane?: string; live?: string }
  // Decision and surface refs hold the snapshot captured when the chip was added, at its revision.
  | { kind: "decision"; id: string; host: string; label: string; editspace: string; revision: number; status: string; lane?: string
      ask: "decision" | "blocker"; question: string; options: string[]; recommendation?: string; updated: number }
  | { kind: "surface"; id: string; host: string; label: string; editspace: string; revision: number; owner: string; lane?: string
      summary?: string; purpose: "board" | "deliverable"; updated: number; health: string }

export type ContextGroup = { name: "Agents" | "Sessions" | "Decisions" | "Surfaces"; items: ContextRef[] }

export type DecisionCandidate = Pick<AttentionRecord, "id" | "editspace" | "revision" | "content_revision" | "status" | "lane" | "kind" | "title"
  | "context" | "options" | "recommendation" | "updated_at">
export type SurfaceCandidate = Pick<Surface, "id" | "title" | "summary" | "owner" | "lane" | "editspace" | "updated_at" | "revision" | "purpose" | "health">

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
  decisions?: readonly DecisionCandidate[]
  surfaces?: readonly SurfaceCandidate[]
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
  // Open questions first, then snoozed; most recently changed first within each.
  const decisions = (input.decisions ?? [])
    .filter((record) => record.status === "open" || record.status === "snoozed")
    .map((record) => ({ record, score: score(record.title, record.lane ?? undefined, record.context) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.record.status !== "open") - Number(b.record.status !== "open") || b.record.updated_at - a.record.updated_at)
    .map(({ record }): ContextRef => ({ kind: "decision", id: record.id, host: input.host, label: record.title, editspace: record.editspace,
      revision: record.content_revision ?? record.revision, status: record.status, lane: record.lane ?? undefined, ask: record.kind,
      question: clip(record.context, 1200), options: record.options.slice(0, 8).map((option) => clip(option.label, 120)),
      recommendation: record.recommendation ? clip(record.recommendation, 300) : undefined, updated: record.updated_at }))
    .filter((ref) => !added.has(contextKey(ref)))
    .slice(0, 6)
  const surfaces = (input.surfaces ?? [])
    .map((surface) => ({ surface, score: score(surface.title, surface.lane ?? undefined, surface.owner, surface.summary ?? undefined) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.surface.updated_at - a.surface.updated_at)
    .map(({ surface }): ContextRef => ({ kind: "surface", id: surface.id, host: input.host, label: surface.title, editspace: surface.editspace,
      revision: surface.revision, owner: surface.owner, lane: surface.lane ?? undefined, summary: surface.summary ? clip(surface.summary, 600) : undefined,
      purpose: surface.purpose ?? "board", updated: surface.updated_at, health: surface.health.state }))
    .filter((ref) => !added.has(contextKey(ref)))
    .slice(0, 6)
  return ([{ name: "Agents", items: agents }, { name: "Sessions", items: sessions }, { name: "Decisions", items: decisions },
    { name: "Surfaces", items: surfaces }] as ContextGroup[]).filter((group) => group.items.length)
}

/** What adding this item attaches, stated before it is added. */
export const contextBound = (ref: ContextRef) => ({
  agent: () => "Adds: agent identity (lane, current session, status, activity) and link. Not the transcript.",
  session: () => "Adds: exact session (title, lane, last updated) and link. Not the transcript.",
  decision: () => `Adds: question + options (rev ${(ref as { revision: number }).revision}), link. Does not answer or notify.`,
  // No surface serves a text snapshot yet, so the bound says the content stays behind the link.
  surface: () => `Adds: title + summary (rev ${(ref as { revision: number }).revision}), link. Not the surface content.`,
})[ref.kind]()

/** Replaces `@query` with a readable `@Label ` so the sentence still reads; the chip carries the context. */
export const insertContextLabel = (text: string, start: number, caret: number, label: string) => {
  const inserted = `@${label.replace(/\s+/g, " ").trim()} `
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length }
}

/** The bounded, source-linked snapshot one chip sends as a synthetic context part. */
export const contextPart = (ref: ContextRef, url: string, asOf: number): ContextPart => {
  const revision = ref.kind === "decision" || ref.kind === "surface" ? { revision: ref.revision } : {}
  const record = { kind: ref.kind, id: ref.id, host: ref.host, ...revision, asOf: new Date(asOf).toISOString(), url }
  const lead = "Context the person attached (a reference, not a request to contact anyone)"
  const lines = ({
    agent: (ref: Extract<ContextRef, { kind: "agent" }>) => [`${lead}: agent for lane ${ref.lane} in editspace ${ref.editspace} on host ${ref.host}.`,
      ref.owner ? `Current session: ${ref.owner}` : "Current session: none recorded",
      ref.status ? `Status: ${clip(ref.status, 40)}` : "", ref.activity ? `Activity: ${clip(ref.activity)}` : ""],
    session: (ref: Extract<ContextRef, { kind: "session" }>) => [`${lead}: session ${ref.id} "${clip(ref.label, 200)}" on host ${ref.host}.`,
      ref.lane ? `Lane: ${ref.lane}` : "", `Last updated: ${new Date(ref.updated).toISOString()}`, `Directory: ${clip(ref.directory)}`],
    decision: (ref: Extract<ContextRef, { kind: "decision" }>) => [
      `${lead}: ${ref.ask} ${ref.id} "${clip(ref.label, 200)}" in editspace ${ref.editspace}${ref.lane ? `, lane ${ref.lane}` : ""} on host ${ref.host}, revision ${ref.revision}, ${ref.status} when attached.`,
      "Attaching it does not answer, approve or notify anyone.",
      ref.options.length ? `Options: ${ref.options.map((option, index) => `${index + 1}) ${option}`).join("; ")}` : "",
      ref.recommendation ? `Recommendation: ${ref.recommendation}` : "", `Question: ${ref.question}`],
    surface: (ref: Extract<ContextRef, { kind: "surface" }>) => [
      `${lead}: surface ${ref.id} "${clip(ref.label, 200)}" (${ref.purpose}) published by ${ref.owner}${ref.lane ? ` for lane ${ref.lane}` : ""} in editspace ${ref.editspace} on host ${ref.host}, revision ${ref.revision}, updated ${new Date(ref.updated).toISOString()}.`,
      ref.summary ? `Summary: ${ref.summary}` : "", "Content: not included (no text snapshot is available); open the link."],
  } as Record<ContextRef["kind"], (ref: ContextRef) => string[]>)[ref.kind](ref).filter(Boolean)
  // The link and reference always survive; the descriptive lines are clipped to fit the byte bound.
  const tail = `\nLink: ${url}\nReference: ${JSON.stringify(record)}`
  const text = `${fitBytes(lines.join("\n"), SNAPSHOT_BYTES - bytes(tail))}${tail}`
  return { type: "text", text, synthetic: true,
    metadata: { source: CONTEXT_MENTION_SOURCE, key: contextKey(ref) } }
}

/* Front desk model: a read-only queue over existing sources, the bounded context
 * note the desk session receives, and derived evidence briefs bound to the exact
 * source revision that started them. No new authority lives here: canonical
 * requests keep their own native controls. */
import type { SessionFailure } from "@opencode-ai/sdk/v2"
import type { MessageWithParts } from "./api"
import type { AttentionRecord } from "./attention"
import type { HomeRequestRow } from "./home-requests"
import { failureLabel } from "./session-failures"
import { memoryLines, type MemoryDocument } from "./desk-memory"

export type DeskItem = {
  key: string
  kind: "decision" | "blocker" | "permission" | "question" | "failure"
  title: string
  project?: string
  /** What a derived brief binds to; a change discards briefs prepared for an earlier value. */
  revision: string
  checked: number
  source: { session: string; directory: string }
  record?: AttentionRecord
  request?: HomeRequestRow
  failure?: SessionFailure
}

export const deskItems = (input: {
  records: AttentionRecord[]
  attentionChecked: number
  requests: HomeRequestRow[]
  failures: SessionFailure[]
  failuresChecked: number
  title: (sessionID: string) => string | undefined
  project: (directory: string) => string | undefined
}): DeskItem[] => [
  ...input.records.filter(record => record.status === "open").map(record => ({
    key: `attention:${record.editspace}:${record.id}`,
    kind: record.kind,
    title: record.title,
    project: record.editspace,
    revision: String(record.revision),
    checked: input.attentionChecked,
    source: { session: record.source_ref.session_id, directory: record.source_ref.directory },
    record,
  })),
  ...input.requests.filter(request => request.state === "pending").map(request => ({
    key: `${request.kind}:${request.directory}:${request.id}`,
    kind: request.kind,
    title: request.kind === "permission" && request.permission ? `${request.permission.permission} · ${request.title}` : request.title,
    project: request.project,
    // A native request is immutable while pending; answering removes it from the queue.
    revision: request.id,
    checked: request.checked,
    source: { session: request.session, directory: request.directory },
    request,
  })),
  ...input.failures.map(failure => ({
    key: `failure:${failure.sessionID}`,
    kind: "failure" as const,
    title: `${failureLabel(failure)} · ${input.title(failure.sessionID) ?? failure.sessionID}`,
    project: input.project(failure.directory),
    revision: failure.messageID,
    checked: input.failuresChecked,
    source: { session: failure.sessionID, directory: failure.directory },
    failure,
  })),
]

export type DeskSource = {
  name: string
  state: "current" | "stale" | "partial" | "unavailable" | "unchecked"
  checked?: number
  detail?: string
}

const STALE_MS = 45_000

export const deskSources = (input: {
  now: number
  attention: { checked?: number; error: string; unavailable: { editspace: string; error?: string }[]; truncated: boolean; operator: boolean }
  requests: { rows: HomeRequestRow[]; error: string }
  failures: { supported?: boolean; error: string; checked?: number }
  dashboard: { stateError: string }
}): DeskSource[] => {
  const age = (checked?: number) => checked ? input.now - checked > STALE_MS : true
  const attention = input.attention
  const unavailable = attention.unavailable.map(item => `${item.editspace}: ${item.error || "unavailable"}`)
  const requestChecked = input.requests.rows.length ? Math.min(...input.requests.rows.map(row => row.checked)) : undefined
  const requestGaps = input.requests.rows.filter(row => row.state === "unavailable").length
  return [
    {
      name: "Attention ledger",
      checked: attention.checked,
      state: attention.error ? "unavailable" : !attention.checked ? "unchecked" : unavailable.length || attention.truncated ? "partial" : age(attention.checked) ? "stale" : "current",
      detail: [attention.error, ...unavailable, attention.truncated ? "history truncated" : "", attention.operator ? "" : "read-only: operator connection unavailable"].filter(Boolean).join("; ") || undefined,
    },
    {
      name: "Native permissions and questions",
      checked: requestChecked,
      state: input.requests.error ? "partial" : requestGaps ? "partial" : !input.requests.rows.length ? "current" : age(requestChecked) ? "stale" : "current",
      detail: [input.requests.error, requestGaps ? `${requestGaps} source request(s) unreachable` : ""].filter(Boolean).join("; ") || undefined,
    },
    {
      name: "Failed sessions",
      checked: input.failures.checked,
      state: input.failures.supported === false ? "unavailable" : input.failures.error ? "stale" : input.failures.supported === undefined ? "unchecked" : age(input.failures.checked) ? "stale" : "current",
      detail: input.failures.supported === false ? "this Core does not report failures" : input.failures.error || undefined,
    },
    {
      name: "Dashboard state",
      state: input.dashboard.stateError ? "unavailable" : "current",
      detail: input.dashboard.stateError || undefined,
    },
  ]
}

export type EvidenceRef = { id: string; label: string; messageID?: string }
export type BriefMeta = { kind: "brief"; requestID: string; source: string; revision: string; title: string; refs: EvidenceRef[] }
export type BriefResult = {
  /** Plain-language framing for the human; empty when the evidence does not support it. */
  ask: string
  whyNow: string
  ifRecommended: string
  ifWait: string
  summary: string
  facts: { text: string; refs: string[] }[]
  timeline: { when?: string; text: string; refs: string[] }[]
  flow: string[]
  gaps: string[]
  /** Model-authored HTML/SVG made for this decision; rendered only in a script-less, network-less sandbox. */
  visual?: { title: string; html: string }
}
export type BriefState =
  | { state: "running" }
  | { state: "ready"; result: BriefResult; omitted: number }
  | { state: "failed"; error: string }
  | { state: "unknown"; reason: string }

const CONTEXT_BUDGET = 10_000
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const ago = (now: number, at?: number) => at ? `${Math.max(0, Math.round((now - at) / 1000))}s ago` : "never"

/** Canonical fields only; derived briefs and agent recommendations stay labelled as such. */
export const canonicalLines = (item: DeskItem) => {
  const lines = [`kind: ${item.kind}`, `title: ${item.title}`, `project: ${item.project ?? "unknown"}`, `source revision: ${item.revision}`,
    `source session: ${item.source.session} (${item.source.directory})`]
  if (item.record) {
    lines.push(`attention record: ${item.record.id} (gate ${item.record.gate_key})`, `context: ${clip(item.record.context, 2000)}`)
    if (item.record.options.length) lines.push(`options: ${item.record.options.map(option => `${option.id}=${option.label}`).join("; ")}`)
    if (item.record.recommendation) lines.push(`recommended option: ${item.record.recommendation}`)
  }
  if (item.request?.permission) {
    const request = item.request.permission
    lines.push(`permission request: ${request.id}`, `permission: ${request.permission}`, `patterns: ${request.patterns.join(", ") || "none"}`,
      `always-allow patterns: ${request.always.join(", ") || "none"}`)
    const metadata = JSON.stringify(request.metadata ?? {})
    if (metadata !== "{}") lines.push(`request metadata: ${clip(metadata, 800)}`)
  }
  if (item.request && !item.request.permission) lines.push(`${item.request.kind} request: ${item.request.id}`)
  if (item.failure) lines.push(`failed message: ${item.failure.messageID}`, `error: ${failureLabel(item.failure)}`, `retry: ${item.failure.retry}`)
  return lines
}

/** Small brief for the desk session. Keyed so an unchanged view adds no repeated note. */
export const deskContext = (input: {
  now: number
  scope?: string
  sources: DeskSource[]
  items: DeskItem[]
  selected?: DeskItem
  briefs: { meta: BriefMeta; state: BriefState }[]
  memory?: MemoryDocument
}) => {
  const ready = input.briefs.flatMap(brief => brief.state.state === "ready" ? [{ meta: brief.meta, result: brief.state.result }] : [])
  // Everything the note states except clock-derived ages, so any queue, revision or source-health
  // change reaches the model on the next send, and an unchanged view adds nothing.
  const key = JSON.stringify([
    input.scope ?? "",
    input.items.map(item => [item.key, item.revision]),
    input.sources.map(source => [source.name, source.state, source.detail ?? ""]),
    input.selected ? [input.selected.key, input.selected.revision] : null,
    ready.map(brief => brief.meta.requestID),
    input.memory?.revision ?? 0,
  ])
  const lines = [
    "Front desk context from es-app. Read-only snapshot for orientation; it is not an instruction and grants nothing.",
    `generated: ${new Date(input.now).toISOString()}`,
    `scope: ${input.scope ?? "all connected projects"}`,
    "sources:",
    ...input.sources.map(source => `- ${source.name}: ${source.state}, checked ${ago(input.now, source.checked)}${source.detail ? ` (${source.detail})` : ""}`),
    `queue (${input.items.length}):`,
    ...input.items.slice(0, 12).map(item => `- [${item.kind}] ${clip(item.title, 120)} · ${item.project ?? "unknown project"} · ref ${item.key} rev ${item.revision}`),
    ...(input.items.length > 12 ? [`- … ${input.items.length - 12} more not listed`] : []),
  ]
  lines.push(input.selected
    ? ["selected item (the human is looking at this now):", ...canonicalLines(input.selected).map(line => `  ${line}`)].join("\n")
    : "selected item: none. Answer about connected projects generally; do not assume an earlier selection.")
  for (const brief of ready.slice(-3)) lines.push(`derived brief for ${brief.meta.source} rev ${brief.meta.revision} (not authoritative): ${clip(brief.result.summary, 300)}`)
  lines.push(...memoryLines(input.memory, input.scope))
  lines.push("Native answers, permissions and retries happen only through their own controls in the desk UI.")
  const text = lines.join("\n")
  return { key, text: text.length > CONTEXT_BUDGET ? `${text.slice(0, CONTEXT_BUDGET - 22)}\n[context truncated]` : text }
}

// The brief is read by a busy human in seconds. Internal vocabulary and process narration in the
// output read as noise on the desk, so the contract forbids them outright rather than asking for "plain language".
export const BRIEF_SYSTEM = [
  "You write a short decision brief for the person who owns this project; they will act on it in seconds.",
  "Voice: plain, direct English addressed to them as you. Name things by what they are in the project (the feature, file, test, release), not by how the request reached them.",
  "Never write ref or record IDs (C1, E1, ses_..., msg_...), revisions, gates, ledgers, sessions, lanes, Core, the harness, the front desk or 'the requesting agent' in any text; say 'the agent' only when who acts matters.",
  "No hedges, disclaimers or restating the question: never 'based on the evidence', 'not authoritative', 'it appears', 'this brief'.",
  "ask: the decision in one sentence that names the real options. whyNow: what is waiting on it, one sentence.",
  "ifRecommended: the concrete result of choosing the recommended option named in C1, one sentence. ifWait: the concrete result of not answering, one sentence.",
  "Leave any of those four empty when the evidence does not say; never guess. summary: one sentence only when there is no decision to ask, otherwise empty.",
  "facts: at most 4, only ones that change the decision. timeline: only when order matters. flow: only steps of the change itself, never the review process (no 'you choose', 'agent resumes').",
  "Every fact and timeline entry cites supplied ref IDs (C1, E1, ...) in refs, never in its text.",
  "You may use read, grep, glob and list (at most 6 calls) to read relevant local files; cite a file you relied on as file:<relative path> in refs.",
  "visual: when a picture makes the choice faster, a small self-contained HTML or inline SVG about the subject itself (the options side by side, before and after, a diagram of the change); never about the agent or this review; no scripts, no external URLs, dark background friendly, under 12 KB; title names what it shows in a few words. Omit it otherwise.",
  "Use only the supplied evidence and files you read. Do not make the decision, do not present an option as chosen, and do not claim anything was approved, sent or retried.",
  "Put what the evidence cannot establish in gaps as short plain phrases. Keep every string short.",
  "Reply with exactly one JSON object and nothing else, matching this JSON Schema:",
].join(" ")

export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ask", "whyNow", "ifRecommended", "ifWait", "summary", "facts", "timeline", "flow", "gaps"],
  properties: {
    ask: { type: "string", maxLength: 200 },
    whyNow: { type: "string", maxLength: 240 },
    ifRecommended: { type: "string", maxLength: 240 },
    ifWait: { type: "string", maxLength: 240 },
    summary: { type: "string", maxLength: 200 },
    facts: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["text", "refs"],
      properties: { text: { type: "string", maxLength: 300 }, refs: { type: "array", minItems: 1, items: { type: "string" } } } } },
    timeline: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["text", "refs"],
      properties: { when: { type: "string", maxLength: 40 }, text: { type: "string", maxLength: 200 }, refs: { type: "array", minItems: 1, items: { type: "string" } } } } },
    flow: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 } },
    gaps: { type: "array", maxItems: 5, items: { type: "string", maxLength: 200 } },
    visual: { type: "object", additionalProperties: false, required: ["title", "html"],
      properties: { title: { type: "string", maxLength: 80 }, html: { type: "string", maxLength: 20000 } } },
  },
}

const EVIDENCE_BUDGET = 5000

/** Producer snippet: canonical fields plus a bounded tail of the source session's visible text.
 * Tool inputs and outputs are never included, only tool names and states, so preparing a brief
 * reads nothing beyond what the source thread already shows the operator. */
export const briefPacket = (item: DeskItem, tail: MessageWithParts[]) => {
  const excerpts = tail.flatMap(message => {
    const text = message.parts.flatMap(part => {
      if (part.type === "text" && !part.synthetic && !part.ignored && part.text.trim()) return [clip(part.text, 500)]
      if (part.type === "tool") return [`(tool ${part.tool}: ${part.state.status})`]
      return []
    }).join(" ")
    return text ? [{ messageID: message.info.id, role: message.info.role, text }] : []
  })
  // Keep the newest evidence when the budget is exceeded.
  const kept: typeof excerpts = []
  let used = 0
  for (const excerpt of excerpts.toReversed()) {
    if (used + excerpt.text.length > EVIDENCE_BUDGET) break
    kept.unshift(excerpt)
    used += excerpt.text.length
  }
  const refs: EvidenceRef[] = [
    { id: "C1", label: `canonical ${item.kind} ${item.key} rev ${item.revision}` },
    ...kept.map((excerpt, index) => ({ id: `E${index + 1}`, label: `${excerpt.role} message in source session`, messageID: excerpt.messageID })),
  ]
  const text = [
    "Prepare an evidence brief for the request below.",
    "",
    "[C1] Canonical request (authoritative, unchanged by this brief):",
    ...canonicalLines(item),
    "",
    kept.length ? `Evidence excerpts from the source session, oldest first (${excerpts.length - kept.length} older excerpt(s) omitted):` : "No source-session excerpts were available.",
    ...kept.map((excerpt, index) => `[E${index + 1}] ${excerpt.role} ${excerpt.messageID}: ${excerpt.text}`),
  ].join("\n")
  return { text, refs }
}

// Citations belong in refs; a bracketed "(C1, E2)" left in prose is stripped so it never reaches the human.
const uncite = (value: string) => value.replace(/\s*[[(](?:[CE]\d+(?:\s*[,;]\s*)?)+[\])]/g, "").trim()
const text = (value: unknown, max: number) => typeof value === "string" ? uncite(value).slice(0, max) : ""
const plain = (value: Record<string, unknown>) =>
  ({ ask: text(value.ask, 200), whyNow: text(value.whyNow, 240), ifRecommended: text(value.ifRecommended, 240), ifWait: text(value.ifWait, 240) })
const visualOf = (value: unknown) => {
  if (!value || typeof value !== "object") return {}
  const visual = value as Record<string, unknown>
  return typeof visual.html === "string" && visual.html.trim() && visual.html.length <= 20000
    ? { visual: { title: text(visual.title, 80), html: visual.html } } : {}
}
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(uncite) : []
const cited = (value: unknown, known: { has: (ref: string) => boolean }) => {
  if (!Array.isArray(value)) return { kept: [], omitted: 0 }
  const rows = value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && typeof (row as Record<string, unknown>).text === "string")
  const kept = rows.flatMap(row => {
    const refs = strings(row.refs).filter(ref => known.has(ref))
    return refs.length ? [{ ...(typeof row.when === "string" ? { when: row.when } : {}), text: uncite(row.text as string), refs }] : []
  })
  return { kept, omitted: value.length - kept.length }
}

// The reply is plain text; tolerate a fenced block, nothing more.
const parseBrief = (message?: MessageWithParts) => {
  const text = message?.parts.flatMap(part => part.type === "text" && !part.synthetic ? [part.text] : []).join("").trim()
  if (!text) return
  try {
    const value: unknown = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""))
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return }
}

/** Derive a brief's state only from its durable Core session; never from local hopes. */
export const briefState = (meta: BriefMeta, messages: MessageWithParts[], status?: string): BriefState => {
  const last = messages.findLast(message => message.info.role === "assistant")
  const assistant = last?.info
  const value = assistant?.role === "assistant" && assistant.time.completed && !assistant.error ? parseBrief(last) : undefined
  if (value) {
    const known = { has: (ref: string) => meta.refs.some(item => item.id === ref) || /^file:[^\s]{1,200}$/.test(ref) }
    const facts = cited(value.facts, known)
    const timeline = cited(value.timeline, known)
    return {
      state: "ready",
      omitted: facts.omitted + timeline.omitted,
      result: { ...plain(value), ...visualOf(value.visual), summary: typeof value.summary === "string" ? uncite(value.summary) : "", facts: facts.kept, timeline: timeline.kept, flow: strings(value.flow), gaps: strings(value.gaps) },
    }
  }
  if (status === "busy" || status === "retry") return { state: "running" }
  if (assistant?.role === "assistant" && assistant.error) return { state: "failed", error: assistant.error.name }
  if (!messages.some(message => message.info.role === "user")) return { state: "unknown", reason: "Brief start not confirmed." }
  if (assistant?.role === "assistant" && assistant.time.completed) return { state: "failed", error: "no readable reply." }
  return { state: "unknown", reason: "Brief stopped before finishing." }
}

/** A derived brief is shown only beside the exact source revision that started it. */
export const briefBinding = (meta: BriefMeta, items: DeskItem[]) => {
  const item = items.find(candidate => candidate.key === meta.source)
  if (!item) return { item, current: false, reason: "Item no longer pending." }
  if (item.revision !== meta.revision) return { item, current: false, reason: `Item changed (revision ${meta.revision} → ${item.revision}).` }
  return { item, current: true, reason: "" }
}

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
    // The error label and failure age are row metadata; the title names the work.
    title: input.title(failure.sessionID) ?? failure.sessionID,
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

/** `url` marks evidence fetched read-only from an external conversation (e.g. a GitHub review thread). */
export type EvidenceRef = { id: string; label: string; messageID?: string; url?: string }
/** `contract` names the brief format; a job made under an older one is kept but not shown or reused. */
export type BriefMeta = { kind: "brief"; requestID: string; source: string; revision: string; title: string; refs: EvidenceRef[]; contract?: number }
export const BRIEF_CONTRACT = 3
export type BriefShape =
  | { kind: "sequence"; steps: string[] }
  | { kind: "scope"; included: string[]; excluded: string[] }
  | { kind: "impact"; rows: { area: string; change: string }[] }
/** A link the brief cites, resolved by the app from evidence refs; never a model-written URL it did not see. */
export type BriefSource = { label: string; refs: string[] }
export type BriefResult = {
  /** The decision as a plain question for someone with only a high-level view of the work. */
  question: string
  /** Only the background that person needs to answer, in a sentence or two; empty when none is needed. */
  context: string
  /** Per canonical option ID: the consequence they would notice, an optional short note (a material risk
   * or fact), and optionally a small picture of what choosing it looks like. Labels and IDs stay the producer's. */
  choices: { id: string; label: string; outcome: string; note: string; sketch?: string }[]
  /** What not answering leads to, only when no option already means that. */
  ifWait: string
  /** For a decision to publish something: the exact text it would send, quoted from the request. */
  sends: string
  /** At most one picture: a shape the app draws, or the model's own visual. */
  shape?: BriefShape
  sources: BriefSource[]
  facts: { text: string; refs: string[] }[]
  timeline: { when?: string; text: string; refs: string[] }[]
  gaps: string[]
  /** Model-authored HTML/SVG explaining the decision, rendered in a script-less, network-less sandbox. */
  visual?: { title: string; html: string; height: number }
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
  if (item.failure) lines.push(`failed message: ${item.failure.messageID}`, `error: ${failureLabel(item.failure)}`,
    `failed at: ${item.failure.time > 0 ? new Date(item.failure.time).toISOString() : "unavailable"}`, `retry: ${item.failure.retry}`)
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
  /** An agent-maintained surface the human has open; its content is not visible to the desk. */
  surface?: { id: string; title: string; owner: string }
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
    input.surface?.id ?? null,
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
  if (input.surface) lines.push(`open surface: "${clip(input.surface.title, 80)}" (id ${input.surface.id}), maintained by ${input.surface.owner}. You cannot see its content; ask its owner for details.`)
  for (const brief of ready.slice(-3)) lines.push(`derived brief for ${brief.meta.source} rev ${brief.meta.revision} (not authoritative): ${clip(brief.result.question, 300)}`)
  lines.push(...memoryLines(input.memory, input.scope))
  lines.push("Native answers, permissions and retries happen only through their own controls in the desk UI.")
  const text = lines.join("\n")
  return { key, text: text.length > CONTEXT_BUDGET ? `${text.slice(0, CONTEXT_BUDGET - 22)}\n[context truncated]` : text }
}

// The brief replaces reading: the human should see the choice, its consequences and one picture,
// then decide. Prose, internal vocabulary and process narration all cost attention, so the contract
// asks for word-limited fields and a structured picture the app draws, not paragraphs.
export const BRIEF_SYSTEM = [
  "You help a busy person decide one request from an agent. Assume they know the project only at a high level: they have not read the agent's thread and do not know its internal names.",
  "Use judgment: show what they need to decide well and nothing else. Every field except question is optional; leave a field empty unless it clearly helps with this decision.",
  "question: the decision as one plain question they can answer, in their terms (what they would see, get or risk), not the agent's task name. Example: 'What should someone see first when opening a workspace?'",
  "context: only if needed, one or two short sentences of background in plain words: what this is about, and why it needs them (who asked, what it would publish or change) when that is not obvious. Mention an uncertainty only if it changes this choice.",
  "choices: for each option listed in C1, by its exact id. label: only if the option's own label uses internal names or configuration (identifiers, tokens, file names), a plain label of a few words in their terms; otherwise empty. outcome: the consequence people would notice if it is chosen, one short complete phrase. note: optionally one short material risk or fact for that option. sketch: optionally, when the options differ in what someone would see, a small self-contained HTML or inline SVG mockup of that option's result, drawn at 16:10 for about 300 by 188 px with text at 11 px or larger (no scripts, no external URLs, dark background, under 6 KB).",
  "ifWait: what happens if they do not answer, only when no option already means not acting.",
  "sends: if choosing an option publishes or sends text (a reply, comment, message, post), that exact text copied verbatim from C1; otherwise empty.",
  "visual: the main explanation whenever a picture communicates faster than text, which is most of the time: a bespoke self-contained HTML or inline SVG made for this decision, like one slide: annotated screen mockups, before and after, a flow or causal chain, a scope map of what is touched and what is not, a timeline, or a comparison. Short labels and callouts only; mark claims that are observed but not measured as such; never chart numbers the evidence does not establish. No scripts, no external URLs, no forms; dark background (#181825), light text; drawn at a fixed width of at most 640 px (set that width on the svg, not 100%), text between 11 and 13 px so it never outsizes the question; under 16 KB. height: the pixel height it needs (120 to 560).",
  "shape: instead of a visual, only for a simple case, the app can draw a sequence of steps, a scope of included versus excluded items, or impact rows of area and change.",
  "The source thread may discuss other work: use only what is about this request.",
  "Put identifiers, commands, file paths, document IDs and other implementation detail only in facts, never in question, context or choices. Never write ref IDs (C1, E1, X1), revisions, gates, ledgers, sessions, lanes, Core or 'the requesting agent' in any text.",
  "Write complete phrases; never stop mid-word. Keep every field short.",
  "sources: at most 3 places worth opening, each with a label saying what it shows and the supplied ref IDs or file:<relative path> it points to. Prefer an original human conversation (X refs) when one is supplied.",
  "facts: up to 4 supporting details shown only on request, each citing supplied ref IDs in refs. Claims stay claims: say who said or measured what. timeline: only when order matters, same rule. gaps: other things the evidence cannot establish.",
  "You may use read, grep, glob and list (at most 6 calls) to read relevant local files; cite a file you relied on as file:<relative path> in refs.",
  "Use only the supplied evidence and files you read. Do not make the decision, do not present an option as chosen, and do not claim anything was approved, sent or retried.",
  "Reply with exactly one JSON object and nothing else, matching this JSON Schema:",
].join(" ")

const words = (maxLength: number) => ({ type: "string", maxLength })
const list = (maxItems: number, maxLength: number) => ({ type: "array", maxItems, items: words(maxLength) })
const cited = (maxItems: number, extra: Record<string, unknown> = {}) => ({ type: "array", maxItems, items: { type: "object", additionalProperties: false, required: ["text", "refs"],
  properties: { ...extra, text: words(200), refs: { type: "array", minItems: 1, items: { type: "string" } } } } })
export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question", "choices"],
  properties: {
    question: words(160),
    context: words(320),
    choices: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "outcome"],
      properties: { id: { type: "string" }, label: words(60), outcome: words(140), note: words(120), sketch: { type: "string", maxLength: 8000 } } } },
    ifWait: words(140),
    sends: words(2000),
    shape: { oneOf: [
      { type: "object", additionalProperties: false, required: ["kind", "steps"], properties: { kind: { const: "sequence" }, steps: list(6, 48) } },
      { type: "object", additionalProperties: false, required: ["kind", "included", "excluded"], properties: { kind: { const: "scope" }, included: list(5, 60), excluded: list(5, 60) } },
      { type: "object", additionalProperties: false, required: ["kind", "rows"], properties: { kind: { const: "impact" }, rows: { type: "array", maxItems: 5, items: {
        type: "object", additionalProperties: false, required: ["area", "change"], properties: { area: words(40), change: words(80) } } } } },
    ] },
    gaps: list(3, 160),
    sources: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["label", "refs"],
      properties: { label: words(80), refs: { type: "array", minItems: 1, items: { type: "string" } } } } },
    facts: cited(4),
    timeline: cited(6, { when: words(40) }),
    visual: { type: "object", additionalProperties: false, required: ["title", "html", "height"], properties: { title: words(80), html: { type: "string", maxLength: 20000 }, height: { type: "integer", minimum: 120, maximum: 560 } } },
  },
}

const EVIDENCE_BUDGET = 5000

/** Producer snippet: canonical fields plus a bounded tail of the source session's visible text.
 * Tool inputs and outputs are never included, only tool names and states, so preparing a brief
 * reads nothing beyond what the source thread already shows the operator. */
/** The original human conversation behind a request, fetched read-only by the dashboard (GitHub review threads). */
export type ConversationThread = { kind: "github-review"; repo: string; number: number; path?: string | null; line?: number | null; url: string
  comments: { author: string; bot: boolean; when: string; body: string; url: string }[] }
export const threadWhere = (thread: ConversationThread) =>
  `GitHub review ${thread.repo}#${thread.number}${thread.path ? ` ${thread.path}:${thread.line}` : ""}`

export const briefPacket = (item: DeskItem, tail: MessageWithParts[], threads: ConversationThread[] = []) => {
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
  const comments = threads.flatMap(thread => thread.comments.map(comment => ({ thread, comment })))
  refs.push(...comments.map(({ thread, comment }, index) => ({ id: `X${index + 1}`, label: `${comment.author}${comment.bot ? " (bot)" : ""} on ${threadWhere(thread)}`, url: comment.url })))
  const text = [
    "Prepare an evidence brief for the request below.",
    "",
    "[C1] Canonical request (authoritative, unchanged by this brief):",
    ...canonicalLines(item),
    "",
    kept.length ? `Evidence excerpts from the source session, oldest first (${excerpts.length - kept.length} older excerpt(s) omitted):` : "No source-session excerpts were available.",
    ...kept.map((excerpt, index) => `[E${index + 1}] ${excerpt.role} ${excerpt.messageID}: ${excerpt.text}`),
    ...(comments.length ? ["", "Original conversation, read-only:"] : []),
    ...comments.map(({ thread, comment }, index) => `[X${index + 1}] ${threadWhere(thread)}, ${comment.author}${comment.bot ? " (bot)" : ""} ${comment.when.slice(0, 10)}: ${comment.body}`),
  ].join("\n")
  return { text, refs }
}

// Citations belong in refs; a bracketed "(C1, E2)" left in prose is stripped so it never reaches the human.
const uncite = (value: string) => value.replace(/\s*[[(](?:[CEX]\d+(?:\s*[,;]\s*)?)+[\])]/g, "").trim()
// Lengths are guidance for the model, not a cut: an overlong field is kept whole up to a generous
// bound and then ends at a word, so critical meaning is never clipped mid-word.
const text = (value: unknown, max: number) => {
  if (typeof value !== "string") return ""
  const clean = uncite(value)
  if (clean.length <= max * 3) return clean
  const cut = clean.slice(0, max * 3)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max)).trimEnd()}…`
}
const strings = (value: unknown, max: number, limit: number) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, limit).map(item => text(item, max)) : []
const objects = (value: unknown) => Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : []
const sketchOf = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 8000 ? { sketch: value } : {}
const choicesOf = (value: unknown) => objects(value).flatMap(row => typeof row.id === "string" && text(row.outcome, 140)
  ? [{ id: row.id, label: text(row.label, 60), outcome: text(row.outcome, 140), note: text(row.note, 120), ...sketchOf(row.sketch) }] : [])
const shapeOf = (value: unknown): { shape?: BriefShape } => {
  const shape = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  if (shape.kind === "sequence") { const steps = strings(shape.steps, 48, 6); return steps.length > 1 ? { shape: { kind: "sequence", steps } } : {} }
  if (shape.kind === "scope") {
    const included = strings(shape.included, 60, 5)
    const excluded = strings(shape.excluded, 60, 5)
    return included.length || excluded.length ? { shape: { kind: "scope", included, excluded } } : {}
  }
  if (shape.kind === "impact") {
    const rows = objects(shape.rows).slice(0, 5).flatMap(row => text(row.area, 40) && text(row.change, 80) ? [{ area: text(row.area, 40), change: text(row.change, 80) }] : [])
    return rows.length ? { shape: { kind: "impact", rows } } : {}
  }
  return {}
}
// The sandboxed frame cannot size itself (no scripts), so the model states the height it drew for.
const visualHeight = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(560, Math.max(120, Math.round(value))) : 280
const visualOf = (value: unknown) => {
  if (!value || typeof value !== "object") return {}
  const visual = value as Record<string, unknown>
  return typeof visual.html === "string" && visual.html.trim() && visual.html.length <= 20000
    ? { visual: { title: text(visual.title, 80), html: visual.html, height: visualHeight(visual.height) } } : {}
}
const citedOf = (value: unknown, known: { has: (ref: string) => boolean }) => {
  const rows = objects(value).filter(row => typeof row.text === "string")
  const kept = rows.flatMap(row => {
    const refs = Array.isArray(row.refs) ? row.refs.filter((ref): ref is string => typeof ref === "string" && known.has(ref)) : []
    return refs.length ? [{ ...(typeof row.when === "string" ? { when: row.when } : {}), text: uncite(row.text as string), refs }] : []
  })
  return { kept, omitted: (Array.isArray(value) ? value.length : 0) - kept.length }
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
    const facts = citedOf(value.facts, known)
    const timeline = citedOf(value.timeline, known)
    return {
      state: "ready",
      omitted: facts.omitted + timeline.omitted,
      result: {
        question: text(value.question, 160), context: text(value.context, 320), choices: choicesOf(value.choices),
        ifWait: text(value.ifWait, 140), sends: typeof value.sends === "string" ? value.sends.trim() : "", ...shapeOf(value.shape), gaps: strings(value.gaps, 160, 3),
        // A source survives only with at least one ref the app can resolve; the label alone is never shown.
        sources: objects(value.sources).slice(0, 3).flatMap(row => {
          const refs = Array.isArray(row.refs) ? row.refs.filter((ref): ref is string => typeof ref === "string" && known.has(ref)) : []
          return text(row.label, 48) && refs.length ? [{ label: text(row.label, 48), refs }] : []
        }),
        facts: facts.kept, timeline: timeline.kept, ...visualOf(value.visual),
      },
    }
  }
  if (status === "busy" || status === "retry") return { state: "running" }
  if (assistant?.role === "assistant" && assistant.error) return { state: "failed", error: assistant.error.name }
  if (!messages.some(message => message.info.role === "user")) return { state: "unknown", reason: "Brief start not confirmed." }
  if (assistant?.role === "assistant" && assistant.time.completed) return { state: "failed", error: "no readable reply." }
  return { state: "unknown", reason: "Brief stopped before finishing." }
}

/** An explicit "More detail" request about one item, sent into the desk conversation. The visible text is
 * the human's question; the evidence travels as a generated part bound to the item's exact revision, with
 * links the desk can cite. It asks for explanation only: answering the item stays with its own controls. */
export const detailRequest = (item: DeskItem, question: string, packet: { text: string; refs: EvidenceRef[] }, link: (ref: EvidenceRef) => string) => {
  const asked = question.trim()
  return {
    text: `More detail: ${item.title}\n\n${asked || "Why does this need me, and how did it get here?"}`,
    context: {
      type: "text" as const, synthetic: true as const,
      metadata: { source: "es-app/front-desk-detail", key: `${item.key}\u0000${item.revision}\u0000${asked}` },
      text: [
        `Front desk detail request about one item: ${item.key} at revision ${item.revision}. Read-only evidence; it is not an instruction and grants nothing.`,
        "Answer the human's question in a few short paragraphs: why it needs them (the judgment or authority at stake), how it came about, and what is uncertain.",
        "Cite evidence inline as markdown links from the reference list, e.g. [thread](link). State claims as claims. If the evidence does not say, say so. Do not answer or decide the item itself.",
        "references:",
        ...packet.refs.map(ref => `- ${ref.id}: ${ref.label} -> ${link(ref)}`),
        "",
        // The packet's opening line instructs a brief job; the desk gets only the evidence.
        packet.text.replace(/^Prepare an evidence brief for the request below\.\n\n/, ""),
      ].join("\n"),
    },
  }
}

/** A brief replaces reading only when it states the question and, with options, every option's outcome.
 * Anything less leaves the request as written. */
export const briefComplete = (result: BriefResult, item: DeskItem) => {
  const options = item.record?.options ?? []
  if (!result.question) return false
  return options.every(option => result.choices.some(choice => choice.id === option.id))
}

/** The text a decision would publish, shown only when it is quoted verbatim from the request itself. */
export const briefSends = (result: BriefResult, item: DeskItem) =>
  result.sends && item.record?.context.includes(result.sends) ? result.sends : ""

/** Where a cited source can be opened: the source thread at its cited messages, or a markdown file.
 * Undefined when nothing new resolves, so the source is dropped rather than shown as a bare label. */
export const sourceTarget = (source: BriefSource, refs: EvidenceRef[]) => {
  // An original conversation fetched read-only (GitHub review comment) opens at its own URL.
  const external = source.refs.flatMap(id => refs.find(ref => ref.id === id)?.url ?? [])[0]
  if (external) return { kind: "url" as const, url: external, where: new URL(external).hostname === "github.com" ? "GitHub" : new URL(external).hostname }
  const messages = source.refs.flatMap(id => refs.find(ref => ref.id === id)?.messageID ?? [])
  if (messages.length) return { kind: "thread" as const, message: messages[0], to: messages.length > 1 ? messages.at(-1) : undefined }
  const doc = source.refs.find(ref => /^file:[^\s]+\.md$/.test(ref))
  // The request alone (C1) opens the same thread as the card's own "Open thread", so it adds nothing.
  if (doc) return { kind: "doc" as const, path: doc.slice(5) }
}

/** A derived brief is shown only beside the exact source revision that started it. */
export const briefBinding = (meta: BriefMeta, items: DeskItem[]) => {
  const item = items.find(candidate => candidate.key === meta.source)
  if (!item) return { item, current: false, reason: "Item no longer pending." }
  if (item.revision !== meta.revision) return { item, current: false, reason: `Item changed (revision ${meta.revision} → ${item.revision}).` }
  return { item, current: true, reason: "" }
}

/* Front desk memory: a small set of notes the desk keeps across sessions. Each change is a new
 * immutable revision with its actor and source. Memory is orientation for the model only;
 * nothing that grants permissions, answers requests or retries work reads it. */
import type { MessageWithParts } from "./api"

export type MemoryEntry = {
  id: string
  text: string
  kind: "preference" | "fact" | "lesson"
  scope: string
  confidence: "stated" | "tentative"
  source: { actor: "human" } | { actor: "assistant"; messageID: string }
  created: number
  updated: number
}
export type MemoryOp =
  | { op: "upsert"; id: string; text: string; kind?: MemoryEntry["kind"]; scope?: string; confidence?: MemoryEntry["confidence"] }
  | { op: "forget"; id: string }
  | { op: "restore"; revision: number }
export type MemoryChange = { op: MemoryOp["op"] | "erase"; entryID?: string; restored?: number; actor: "human" | "assistant"; messageID?: string; opKey?: string }
export type MemoryRevision = { n: number; entries: MemoryEntry[]; change: MemoryChange; at: number }
/** The personal memory file. `applied` carries the desk's recent change keys forward, so erasing
 * history or restoring an earlier revision never makes an applied reply apply again. */
export type MemoryDocument = { format: "front-desk-memory/1"; revision: number; entries: MemoryEntry[]; applied: string[]; history: MemoryRevision[] }
export const emptyMemory = (): MemoryDocument => ({ format: "front-desk-memory/1", revision: 0, entries: [], applied: [], history: [] })
const APPLIED_LIMIT = 200
const HISTORY_LIMIT = 50
export const appliedKeys = (document: MemoryDocument) => new Set([...document.applied, ...document.history.flatMap(revision => revision.change.opKey ? [revision.change.opKey] : [])])

/** The next document for one change, or why it was refused. History stays bounded. */
export const nextMemory = (document: MemoryDocument, op: MemoryOp, actor: MemoryChange["actor"], now: number, source?: { messageID: string; opKey: string }):
  MemoryDocument | { refused: string } => {
  const result = applyMemory(document.history.length ? document.history : document.revision ? [{ n: document.revision, entries: document.entries, change: { op: "upsert", actor: "human" }, at: now }] : [], op, actor, now, source?.messageID)
  if ("refused" in result) return result
  const n = document.revision + 1
  const change = { ...result.change, ...(source ? { opKey: source.opKey } : {}) }
  return {
    format: "front-desk-memory/1", revision: n, entries: result.entries,
    applied: source ? [...document.applied, source.opKey].slice(-APPLIED_LIMIT) : document.applied,
    history: [...document.history, { n, at: now, change, entries: result.entries }].slice(-HISTORY_LIMIT),
  }
}

/** Remove a forgotten note's text from every earlier revision, as a new revision of its own. */
export const eraseMemory = (document: MemoryDocument, entryID: string, now: number): MemoryDocument | { refused: string } => {
  if (document.entries.some(entry => entry.id === entryID)) return { refused: `Forget "${entryID}" before erasing it.` }
  if (!document.history.some(revision => revision.entries.some(entry => entry.id === entryID))) return { refused: `"${entryID}" is not in history.` }
  const n = document.revision + 1
  return {
    ...document, revision: n,
    history: [...document.history.map(revision => ({ ...revision, entries: revision.entries.filter(entry => entry.id !== entryID) })),
      { n, at: now, change: { op: "erase" as const, entryID, actor: "human" as const }, entries: document.entries }].slice(-HISTORY_LIMIT),
  }
}

export const MEMORY_LIMITS = { entries: 40, chars: 4000, text: 300 }
const KINDS = new Set(["preference", "fact", "lesson"])
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
]

/** Apply one change. Returns the next entries or a reason it was refused; never prunes silently. */
export const applyMemory = (history: MemoryRevision[], op: MemoryOp, actor: MemoryChange["actor"], now: number, messageID?: string):
  { entries: MemoryEntry[]; change: MemoryChange } | { refused: string } => {
  const current = history.at(-1)?.entries ?? []
  const base = { actor, ...(messageID ? { messageID } : {}) }
  if (op.op === "restore") {
    const target = history.find(revision => revision.n === op.revision)
    if (!target) return { refused: `Revision ${op.revision} is not in history.` }
    return { entries: target.entries, change: { op: "restore", restored: op.revision, ...base } }
  }
  if (op.op === "forget") {
    if (!current.some(entry => entry.id === op.id)) return { refused: `No note "${op.id}" to forget.` }
    return { entries: current.filter(entry => entry.id !== op.id), change: { op: "forget", entryID: op.id, ...base } }
  }
  const text = op.text.replace(/\s+/g, " ").trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(op.id)) return { refused: "Note IDs are short lowercase words (letters, digits, . _ -)." }
  if (!text) return { refused: "A note needs text." }
  if (text.length > MEMORY_LIMITS.text) return { refused: `Notes are at most ${MEMORY_LIMITS.text} characters.` }
  if (SECRET.some(pattern => pattern.test(text))) return { refused: "This looks like a credential. Memory never stores secrets." }
  const previous = current.find(entry => entry.id === op.id)
  if (current.some(entry => entry.id !== op.id && entry.text === text)) return { refused: "The same note already exists." }
  const entry: MemoryEntry = {
    id: op.id,
    text,
    kind: op.kind && KINDS.has(op.kind) ? op.kind : previous?.kind ?? "fact",
    scope: op.scope && /^(global|project:[\w.-]+)$/.test(op.scope) ? op.scope : previous?.scope ?? "global",
    confidence: op.confidence === "stated" || op.confidence === "tentative" ? op.confidence : previous?.confidence ?? (actor === "human" ? "stated" : "tentative"),
    source: actor === "assistant" && messageID ? { actor, messageID } : { actor: "human" },
    created: previous?.created ?? now,
    updated: now,
  }
  if (previous && previous.text === entry.text && previous.kind === entry.kind && previous.scope === entry.scope && previous.confidence === entry.confidence)
    return { refused: "No change." }
  const entries = previous ? current.map(item => item.id === op.id ? entry : item) : [...current, entry]
  if (entries.length > MEMORY_LIMITS.entries) return { refused: `Memory holds at most ${MEMORY_LIMITS.entries} notes. Forget one first.` }
  if (entries.reduce((sum, item) => sum + item.text.length, 0) > MEMORY_LIMITS.chars) return { refused: `Memory holds at most ${MEMORY_LIMITS.chars} characters. Shorten or forget a note first.` }
  return { entries, change: { op: "upsert", entryID: op.id, ...base } }
}

const BLOCK = /```front-desk-memory\s*\n([\s\S]*?)```/g

/** Memory changes the desk asked for in its own completed replies, each with a stable key. */
export const assistantOps = (messages: MessageWithParts[]) => messages.flatMap(message => {
  const info = message.info
  if (info.role !== "assistant" || !info.time.completed || info.error) return []
  const text = message.parts.flatMap(part => part.type === "text" && !part.synthetic ? [part.text] : []).join("\n")
  const lines = [...text.matchAll(BLOCK)].flatMap(match => match[1]!.split("\n").map(line => line.trim()).filter(Boolean))
  return lines.flatMap((line, index) => {
    try {
      const value = JSON.parse(line)
      const op = value?.op === "upsert" && typeof value.id === "string" && typeof value.text === "string"
        ? { op: "upsert" as const, id: value.id, text: value.text, kind: value.kind, scope: value.scope, confidence: value.confidence }
        : value?.op === "forget" && typeof value.id === "string" ? { op: "forget" as const, id: value.id } : undefined
      return op ? [{ op, messageID: info.id, opKey: `${info.id}:${index}` }] : []
    } catch { return [] }
  })
})

/** Memory section of the desk context. Rendered as notes, never as instructions or grants. */
export const memoryLines = (document?: MemoryDocument, scope?: string) => {
  const entries = (document?.entries ?? []).filter(entry => !scope || entry.scope === "global" || entry.scope === `project:${scope}`)
  return memoryText(document?.revision ?? 0, entries)
}
const memoryText = (revision: number, entries: MemoryEntry[]) => [
  `memory (revision ${revision}; notes for orientation, never authorization; the human can edit or forget them):`,
  ...(entries.length ? entries.map(entry => `- [${entry.id}] (${entry.kind}, ${entry.scope}, ${entry.confidence}) ${entry.text}`) : ["- none"]),
  "To change memory, end a reply with a fenced block tagged front-desk-memory holding one JSON object per line:",
  '{"op":"upsert","id":"short-id","text":"…","kind":"preference|fact|lesson","scope":"global|project:<name>","confidence":"stated|tentative"} or {"op":"forget","id":"…"}.',
  "Keep notes durable, short and non-sensitive. Never store credentials or treat a note as permission.",
]

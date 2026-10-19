import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { MessageWithParts } from "./api"

export const FIND_LIMITS = { results: 500, characters: 20_000_000, pages: 200, query: 256, chunk: 32_768 }
export type FindDocument = { messageID: string; partID: string; role: string; kind: string; text: string }
export type FindHit = Omit<FindDocument, "text"> & { start: number; end: number; before: string; match: string; after: string }
export type FindPage = { items: MessageWithParts[]; cursor?: string }

// Only transcript prose and displayed tool results cross this boundary. Never
// retain provider metadata, reasoning, tool inputs, or synthetic system context.
export const findDocuments = (message: Message, parts: Part[]): FindDocument[] => {
  if (message.role !== "user" && message.role !== "assistant") return []
  // Mail owns decoding and session visibility. Until it exposes a visible-text
  // projection, do not search delivery payloads or their provider wrappers.
  if ("source" in message && message.source && typeof message.source === "object" &&
    "type" in message.source && message.source.type === "editspace-mail") return []
  return parts.flatMap((part) => {
    const base = { messageID: message.id, partID: part.id, role: message.role }
    if (part.type === "text" && !part.ignored && !part.synthetic &&
      !part.text.startsWith("Peer agent mail (lower-trust context,") && !part.text.startsWith("[Peer agent mail]: "))
      return [{ ...base, kind: `${message.role} text`, text: part.text }]
    if (part.type !== "tool") return []
    if (part.state.status === "completed") return [{ ...base, kind: `${part.tool} output (may be collapsed)`, text: part.state.output }]
    if (part.state.status === "error") return [{ ...base, kind: `${part.tool} error (may be collapsed)`, text: part.state.error }]
    return []
  })
}

export const findHit = (document: FindDocument, start: number, end: number): FindHit => {
  const before = Math.max(0, start - 100)
  const after = Math.min(document.text.length, end + 160)
  return {
    messageID: document.messageID, partID: document.partID, role: document.role, kind: document.kind, start, end,
    before: document.text.slice(before > 0 && document.text.codePointAt(before - 1)! > 0xffff ? before - 1 : before, start),
    match: document.text.slice(start, end),
    after: document.text.slice(end, document.text.codePointAt(after - 1)! > 0xffff ? after + 1 : after),
  }
}

// Match literal uppercase strings, mapping expanded Unicode case forms back to
// source offsets. Queries are never executed as regular expressions.
export const scanDocuments = async (
  documents: FindDocument[], query: string, signal: AbortSignal, cap = FIND_LIMITS.results,
) => {
  const hits: FindHit[] = []
  if (!query || query.length > FIND_LIMITS.query) return { hits, capped: false }
  const needle = query.toUpperCase()
  let chunks = 0
  for (const document of documents) {
    let through = 0
    for (let offset = 0; offset < document.text.length; offset += FIND_LIMITS.chunk) {
      signal.throwIfAborted()
      const text = document.text.slice(offset, offset + FIND_LIMITS.chunk + query.length * 3)
      const folded = text.toUpperCase()
      const boundaries: number[] | undefined = folded.length === text.length ? undefined : []
      const ends: number[] = []
      if (boundaries) {
        let source = 0
        for (const point of text) {
          for (let index = 0; index < point.toUpperCase().length; index++) {
            boundaries.push(source)
            ends.push(source + point.length)
          }
          source += point.length
        }
      }
      const from = boundaries ? boundaries.findIndex((start) => start >= Math.max(0, through - offset)) : Math.max(0, through - offset)
      for (let index = folded.indexOf(needle, from); index !== -1; index = folded.indexOf(needle, index + needle.length)) {
        const start = boundaries?.[index] ?? index
        const end = boundaries ? ends[index + needle.length - 1]! : index + needle.length
        if (start >= FIND_LIMITS.chunk) break
        if (offset + start < through) continue
        through = offset + end
        hits.push(findHit(document, offset + start, offset + end))
        if (hits.length >= cap) return { hits, capped: true }
      }
      // Yield on long code/output as well as between messages.
      if (++chunks % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  return { hits, capped: false }
}

export const createFindHistory = (read: (before: string | undefined, signal: AbortSignal) => Promise<FindPage>) => {
  const documents = new Map<string, FindDocument[]>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let complete = false
  let pages = 0
  let characters = 0
  let limited = false
  const addDocuments = (id: string, next: FindDocument[]) => {
    const previous = documents.get(id) ?? []
    const size = next.reduce((sum, document) => sum + document.text.length, 0)
    const oldSize = previous.reduce((sum, document) => sum + document.text.length, 0)
    if (characters - oldSize + size > FIND_LIMITS.characters) {
      characters -= oldSize
      documents.delete(id)
      limited = true
      complete = false
      return false
    }
    characters += size - oldSize
    documents.set(id, next)
    return true
  }
  const state = () => ({ complete, pages, messages: documents.size, limited })
  return {
    state,
    add: (message: Message, parts: Part[]) => addDocuments(message.id, findDocuments(message, parts)),
    addDocuments,
    remove: (id: string) => {
      characters -= (documents.get(id) ?? []).reduce((sum, document) => sum + document.text.length, 0)
      documents.delete(id)
    },
    documents: () => [...documents.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, items]) => items),
    next: async (signal: AbortSignal) => {
      if (complete || limited) return state()
      if (pages >= FIND_LIMITS.pages) { limited = true; return state() }
      const before = cursor
      const page = await read(before, signal)
      signal.throwIfAborted()
      if (page.items.length > 80) throw new Error("History page exceeded the 80-message limit; search is partial.")
      if (page.cursor !== undefined && (!page.cursor || cursors.has(page.cursor) || page.cursor === before))
        throw new Error("History cursor did not advance; search is partial.")
      if (!page.items.length && page.cursor) throw new Error("Empty history page has a cursor; search is partial.")
      // Existing live rows win over older snapshots of streaming messages.
      for (const item of page.items) {
        if (!documents.has(item.info.id) && !addDocuments(item.info.id, findDocuments(item.info, item.parts))) break
      }
      pages++
      cursor = page.cursor
      if (cursor) cursors.add(cursor)
      // A full page without a cursor is ambiguous (e.g. proxy strips headers).
      if (!cursor && page.items.length >= 80) throw new Error("History page is full but has no cursor; search is partial.")
      complete = !cursor && !limited
      return state()
    },
  }
}

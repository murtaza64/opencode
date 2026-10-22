import type { SessionRow } from "./state"

// A reference is the exact `@ses_…` ID plus an optional descriptive suffix
// written at insertion. The ID alone routes; the suffix is model-visible intent.
const TOKEN = /@ses_[A-Za-z0-9]{26}(?![A-Za-z0-9])(?: \(session [^()\n]*\))?/g

export const mentionQuery = (text: string, caret: number) => {
  if (caret < 0 || caret > text.length) return undefined
  const match = /(^|\s)@(\S*)$/.exec(text.slice(0, caret))
  if (!match) return undefined
  return { start: caret - match[2]!.length - 1, query: match[2]! }
}

export const mentionText = (id: string, context: { title?: string; lane?: string } = {}) => {
  // Parentheses and newlines would end the suffix early, so they are neutralized.
  const clean = (value?: string) => (value ?? "").replace(/\s+/g, " ").replace(/\(/g, "[").replace(/\)/g, "]").trim()
  const title = clean(context.title)
  const lane = clean(context.lane)
  if (!title && !lane) return `@${id}`
  return `@${id} (${[title ? `session "${title}"` : "session", lane && `lane ${lane}`].filter(Boolean).join(" · ")})`
}

export const insertMention = (text: string, start: number, caret: number, id: string, context?: { title?: string; lane?: string }) => {
  const inserted = `${mentionText(id, context)} `
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length }
}

export const findMentions = (text: string) =>
  [...text.matchAll(TOKEN)].map((match) => ({ start: match.index, end: match.index + match[0].length, id: match[0].slice(1, 31) }))

export const tokenBefore = (text: string, caret: number) =>
  findMentions(text).find((match) => match.end === caret)

export const rankSessions = (rows: SessionRow[], query: string, currentID: string) => {
  const needle = query.toLocaleLowerCase().replace(/^@/, "")
  const score = (row: SessionRow) => {
    if (!needle) return 1
    const title = row.title.toLocaleLowerCase()
    if (title.startsWith(needle)) return 3
    if (title.includes(needle)) return 2
    if ((row.project ?? "").toLocaleLowerCase().includes(needle) ||
      (row.directory.split("/").filter(Boolean).at(-1) ?? "").toLocaleLowerCase().includes(needle)) return 1
    return 0
  }
  return rows.filter((row) => row.id !== currentID && !row.archived && score(row) > 0)
    .sort((a, b) => score(b) - score(a) || b.updated - a.updated).slice(0, 8)
}

// Lane comes only from es lane records: a current owner or either side of a
// recorded handoff. Scoped lanes are JSON `[editspace, lane]` pairs.
export const sessionLane = (
  id: string,
  handoffs: readonly { lane: string; predecessor: string; successor: string }[],
  owners: readonly { lane: string; owner: string }[],
) => {
  const scoped = owners.find((owner) => owner.owner === id)?.lane ??
    handoffs.find((edge) => edge.predecessor === id || edge.successor === id)?.lane
  if (!scoped) return undefined
  const parsed: unknown = JSON.parse(scoped)
  return Array.isArray(parsed) && typeof parsed[1] === "string" ? parsed[1] : undefined
}

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

export const findMentions = (text: string) =>
  [...text.matchAll(TOKEN)].map((match) => ({ start: match.index, end: match.index + match[0].length, id: match[0].slice(1, 31) }))

export const tokenBefore = (text: string, caret: number) =>
  findMentions(text).find((match) => match.end === caret)

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

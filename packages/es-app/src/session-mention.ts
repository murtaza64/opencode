import type { SessionRow } from "./state"

const TOKEN = /@ses_[A-Za-z0-9]{26}(?![A-Za-z0-9])/g

export const mentionQuery = (text: string, caret: number) => {
  if (caret < 0 || caret > text.length) return undefined
  const match = /(^|\s)@(\S*)$/.exec(text.slice(0, caret))
  if (!match) return undefined
  return { start: caret - match[2]!.length - 1, query: match[2]! }
}

export const insertMention = (text: string, start: number, caret: number, id: string) => {
  const inserted = `@${id} `
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length }
}

export const findMentions = (text: string) =>
  [...text.matchAll(TOKEN)].map((match) => ({ start: match.index, end: match.index + match[0].length, id: match[0].slice(1) }))

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

import { describe, expect, test } from "bun:test"
import { findMentions, insertMention, mentionQuery, mentionText, rankSessions, sessionLane, tokenBefore } from "./session-mention"

const first = `ses_${"A".repeat(26)}`
const second = `ses_${"B".repeat(26)}`

describe("mentionQuery", () => {
  test("accepts start, whitespace, newline and empty queries", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" })
    expect(mentionQuery("hello @orch", 11)).toEqual({ start: 6, query: "orch" })
    expect(mentionQuery("hello\n@or", 9)).toEqual({ start: 6, query: "or" })
  })
  test("rejects mid-word, whitespace after query, and caret out of range", () => {
    expect(mentionQuery("a@b", 3)).toBeUndefined()
    expect(mentionQuery("@or done", 8)).toBeUndefined()
    expect(mentionQuery("@or", 4)).toBeUndefined()
  })
})

test("insertMention replaces only the active query and positions the caret after the space", () => {
  expect(insertMention("hello @or more", 6, 9, first)).toEqual({ text: `hello @${first}  more`, caret: 6 + first.length + 2 })
})

test("insertMention writes title and lane context after the exact session ID", () => {
  const inserted = `@${first} (session "Relay" · lane orchestrator) `
  expect(insertMention("ask @rel now", 4, 8, first, { title: "Relay", lane: "orchestrator" })).toEqual({ text: `ask ${inserted} now`, caret: 4 + inserted.length })
})

test("mentionText omits unknown lane and title and neutralizes characters that would end the suffix", () => {
  expect(mentionText(first, { title: "Relay" })).toBe(`@${first} (session "Relay")`)
  expect(mentionText(first, { lane: "orchestrator" })).toBe(`@${first} (session · lane orchestrator)`)
  expect(mentionText(first, {})).toBe(`@${first}`)
  expect(mentionText(first, { title: "Fix (urgent)\n now" })).toBe(`@${first} (session "Fix [urgent] now")`)
})

test("findMentions treats the context suffix as part of the reference and keeps the bare ID as identity", () => {
  const reference = `@${first} (session "Relay" · lane orchestrator)`
  const text = `see ${reference} and @${second} (later)`
  expect(findMentions(text)).toEqual([
    { start: 4, end: 4 + reference.length, id: first },
    { start: 4 + reference.length + 5, end: 4 + reference.length + 6 + second.length, id: second },
  ])
  expect(tokenBefore(text, 4 + reference.length)?.id).toBe(first)
  expect(findMentions(`@${first} (session "Relay"`)).toEqual([{ start: 0, end: first.length + 1, id: first }])
})

test("sessionLane reads lane records for owners and handed-off sessions and is undefined otherwise", () => {
  const scope = (lane: string) => JSON.stringify(["opencode", lane])
  const handoffs = [{ lane: scope("orchestrator"), predecessor: "ses_old", successor: "ses_new" }]
  const owners = [{ lane: scope("builder"), owner: "ses_owner" }]
  expect(sessionLane("ses_owner", handoffs, owners)).toBe("builder")
  expect(sessionLane("ses_old", handoffs, owners)).toBe("orchestrator")
  expect(sessionLane("ses_new", handoffs, owners)).toBe("orchestrator")
  expect(sessionLane("ses_other", handoffs, owners)).toBeUndefined()
})

test("findMentions finds complete tokens and tokenBefore only matches the exact end", () => {
  const text = `@${first} then ${second} @ses_short @${second}extra`
  expect(findMentions(text)).toEqual([{ start: 0, end: first.length + 1, id: first }])
  expect(tokenBefore(text, first.length + 1)).toEqual({ start: 0, end: first.length + 1, id: first })
  expect(tokenBefore(text, first.length)).toBeUndefined()
  expect(tokenBefore(`@${first}x`, first.length + 1)).toBeUndefined()
})

test("rankSessions excludes self and archived, scores title before project or basename, breaks ties by recency and caps at eight", () => {
  const rows = [
    { id: "self", title: "Orchestra", directory: "/self", updated: 100 },
    { id: "archived", title: "Orchid", directory: "/old", updated: 100, archived: 1 },
    { id: "prefix", title: "Orchard", directory: "/a", updated: 1 },
    { id: "titlePrefix", title: "Orchestra main", directory: "/p", updated: 1 },
    { id: "substring", title: "Big orchestra", directory: "/b", updated: 100 },
    { id: "project", title: "Misc", directory: "/c", project: "Orchid", updated: 100 },
    { id: "basename", title: "Other", directory: "/a/orchestra", updated: 50 },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `recent${i}`, title: "Orch", directory: "/z", updated: i + 2 })),
  ]
  expect(rankSessions(rows, "orchard", "self").map((row) => row.id)).toEqual(["prefix"])
  expect(rankSessions(rows, "orchestra", "self").map((row) => row.id)).toEqual(["titlePrefix", "substring", "basename"])
  expect(rankSessions(rows, "", "self")).toHaveLength(8)
  expect(rankSessions(rows, "orch", "self")[0]?.id).toBe("recent11")
  expect(rankSessions(rows, "orchid", "self").map((row) => row.id)).toEqual(["project"])
})

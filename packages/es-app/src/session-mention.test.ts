import { describe, expect, test } from "bun:test"
import { findMentions, mentionQuery, mentionText, sessionLane, tokenBefore } from "./session-mention"

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


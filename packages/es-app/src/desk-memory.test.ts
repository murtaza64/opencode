import { expect, test } from "bun:test"
import type { MessageWithParts } from "./api"
import { appliedKeys, applyMemory, assistantOps, emptyMemory, eraseMemory, memoryLines, MEMORY_LIMITS, nextMemory, type MemoryDocument, type MemoryRevision } from "./desk-memory"

const revision = (n: number, entries: MemoryRevision["entries"]): MemoryRevision => ({ n, entries, change: { op: "upsert", actor: "human" }, at: n })
const saved = (history: MemoryRevision[], text: string, id = "pref") => {
  const result = applyMemory(history, { op: "upsert", id, text }, "human", 10)
  if ("refused" in result) throw new Error(result.refused)
  return [...history, { n: history.length + 1, entries: result.entries, change: result.change, at: 10 }]
}
const reply = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  info: { id, role: "assistant", sessionID: "ses_desk", time: { created: 1, completed: 2 }, ...extra },
  parts: [{ id: `prt_${id}`, type: "text", text, sessionID: "ses_desk", messageID: id }],
}) as unknown as MessageWithParts

test("an upsert by the same id replaces the note and keeps its creation time", () => {
  const first = saved([], "Prefers short replies")
  const result = applyMemory(first, { op: "upsert", id: "pref", text: "Prefers very short replies" }, "assistant", 20, "msg_a")
  expect(result).toMatchObject({ entries: [{ id: "pref", text: "Prefers very short replies", created: 10, updated: 20, source: { actor: "assistant", messageID: "msg_a" } }] })
})

test("assistant notes default to tentative and human notes to stated", () => {
  expect(applyMemory([], { op: "upsert", id: "a", text: "x" }, "assistant", 1, "msg")).toMatchObject({ entries: [{ confidence: "tentative" }] })
  expect(applyMemory([], { op: "upsert", id: "a", text: "x" }, "human", 1)).toMatchObject({ entries: [{ confidence: "stated" }] })
})

test("credentials, oversize notes, duplicates and over-cap memory are refused, never pruned", () => {
  expect(applyMemory([], { op: "upsert", id: "k", text: "api_key = abcdef123456" }, "assistant", 1, "m")).toEqual({ refused: "This looks like a credential. Memory never stores secrets." })
  expect(applyMemory([], { op: "upsert", id: "k", text: "token ghp_ABCDEFGHIJKLMNOPQRST" }, "human", 1)).toHaveProperty("refused")
  expect(applyMemory([], { op: "upsert", id: "k", text: "x".repeat(MEMORY_LIMITS.text + 1) }, "human", 1)).toHaveProperty("refused")
  expect(applyMemory(saved([], "same", "a"), { op: "upsert", id: "b", text: "same" }, "human", 1)).toEqual({ refused: "The same note already exists." })
  const full = [revision(1, Array.from({ length: MEMORY_LIMITS.entries }, (_, i) => ({ id: `n${i}`, text: `note ${i}`, kind: "fact" as const, scope: "global", confidence: "stated" as const, source: { actor: "human" as const }, created: 1, updated: 1 })))]
  expect(applyMemory(full, { op: "upsert", id: "extra", text: "one more" }, "human", 1)).toEqual({ refused: `Memory holds at most ${MEMORY_LIMITS.entries} notes. Forget one first.` })
})

test("forget removes a note and restore copies an earlier revision forward", () => {
  const history = saved(saved([], "A", "a"), "B", "b")
  const forgot = applyMemory(history, { op: "forget", id: "a" }, "human", 30)
  expect(forgot).toMatchObject({ entries: [{ id: "b" }], change: { op: "forget", entryID: "a" } })
  expect(applyMemory(history, { op: "restore", revision: 1 }, "human", 30)).toMatchObject({ entries: [{ id: "a" }], change: { op: "restore", restored: 1 } })
  expect(applyMemory(history, { op: "forget", id: "zzz" }, "human", 30)).toHaveProperty("refused")
})

test("only fenced memory blocks in completed, successful desk replies become changes, keyed per line", () => {
  const ops = assistantOps([
    reply("msg_1", 'Noted.\n```front-desk-memory\n{"op":"upsert","id":"tz","text":"Works in UTC","kind":"preference"}\nnot json\n{"op":"forget","id":"old"}\n```'),
    reply("msg_2", '```front-desk-memory\n{"op":"upsert","id":"x","text":"y"}\n```', { time: { created: 1 } }),
    reply("msg_3", '```front-desk-memory\n{"op":"upsert","id":"x","text":"y"}\n```', { error: { name: "APIError" } }),
    reply("msg_4", '```json\n{"op":"upsert","id":"x","text":"y"}\n```'),
  ])
  expect(ops.map(item => [item.opKey, item.op.op])).toEqual([["msg_1:0", "upsert"], ["msg_1:2", "forget"]])
})

const doc = (next: MemoryDocument | { refused: string }) => { if ("refused" in next) throw new Error(next.refused); return next }

test("memory context labels notes as never authorization and keeps only global or current-project notes", () => {
  const one = doc(nextMemory(emptyMemory(), { op: "upsert", id: "pref", text: "Prefers canaries" }, "human", 1))
  const two = doc(nextMemory(one, { op: "upsert", id: "beta", text: "Beta ships Fridays", scope: "project:beta" }, "human", 2))
  const lines = memoryLines(two, "alpha").join("\n")
  expect(lines).toContain("notes for orientation, never authorization")
  expect(lines).toContain("[pref] (fact, global, stated) Prefers canaries")
  expect(lines).not.toContain("Beta ships")
  expect(memoryLines(two, "beta").join("\n")).toContain("Beta ships Fridays")
  expect(memoryLines(two).join("\n")).toContain("Beta ships Fridays")
})

test("a desk change records its source and stays applied after its history is erased", () => {
  const added = doc(nextMemory(emptyMemory(), { op: "upsert", id: "tz", text: "Works in UTC" }, "assistant", 1, { messageID: "msg_1", opKey: "msg_1:0" }))
  expect(added.history.at(-1)!.change).toEqual({ op: "upsert", entryID: "tz", actor: "assistant", messageID: "msg_1", opKey: "msg_1:0" })
  const forgot = doc(nextMemory(added, { op: "forget", id: "tz" }, "human", 2))
  expect(eraseMemory(added, "tz", 3)).toEqual({ refused: 'Forget "tz" before erasing it.' })
  const erased = doc(eraseMemory(forgot, "tz", 3))
  expect(JSON.stringify(erased.history.map(item => item.entries))).not.toContain("Works in UTC")
  expect(erased.history.map(item => item.change.op)).toEqual(["upsert", "forget", "erase"])
  expect(appliedKeys(erased).has("msg_1:0")).toBe(true)
})

test("history stays bounded and restore reaches only retained revisions", () => {
  let current = emptyMemory()
  for (let i = 0; i < 55; i++) current = doc(nextMemory(current, { op: "upsert", id: "n", text: `note ${i}` }, "human", i))
  expect(current.history).toHaveLength(50)
  expect(current.history[0]!.n).toBe(6)
  expect(nextMemory(current, { op: "restore", revision: 3 }, "human", 99)).toEqual({ refused: "Revision 3 is not in history." })
  expect(doc(nextMemory(current, { op: "restore", revision: 6 }, "human", 99)).entries[0]!.text).toBe("note 5")
})

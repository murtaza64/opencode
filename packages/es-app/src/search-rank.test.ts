import { expect, test } from "bun:test"
import { rankSearch } from "./search-rank"

type Row = { key: string; title: string; lane?: string; updated: number }
const row = (key: string, title: string, updated: number, lane?: string): Row => ({ key, title, updated, ...(lane ? { lane } : {}) })
const newest = (a: Row, b: Row) => b.updated - a.updated

test("a pin that does not match stays visible, in pin order, marked as not matching", () => {
  const pins = [row("ses_b", "Billing export", 1), row("mini:ses_a", "Auth refresh", 2)]
  const ranked = rankSearch({ query: "auth", pinned: pins, known: [...pins, row("ses_c", "auth logs", 3)], transcriptHits: [], order: newest })
  expect(ranked.pinned.map((item) => [item.row.key, item.matches])).toEqual([["ses_b", false], ["mini:ses_a", true]])
  expect(ranked.metadata.map((item) => item.key)).toEqual(["ses_c"])
})

test("a title or lane match outranks any transcript-only match, however new", () => {
  const known = [row("ses_old", "Fix auth flow", 1), row("cloud:opencode/auth-lane", "worker", 2, "auth-lane")]
  const hits = [row("ses_new", "Unrelated title", 99), row("ses_old", "Fix auth flow", 1)]
  const ranked = rankSearch({ query: "AUTH", pinned: [], known, transcriptHits: hits, order: newest })
  expect(ranked.metadata.map((item) => item.key)).toEqual(["cloud:opencode/auth-lane", "ses_old"])
  expect(ranked.transcript.map((item) => item.key)).toEqual(["ses_new"])
})

test("a truncated transcript page cannot drop a metadata match: known rows are searched on their own", () => {
  // The server returned only its 30 newest hits, all transcript-only; the title match was cut off.
  const hits = Array.from({ length: 30 }, (_, index) => row(`ses_t${index}`, `Session ${index}`, 100 + index))
  const ranked = rankSearch({ query: "parser", pinned: [], known: [row("ses_title", "Rewrite the parser", 1)], transcriptHits: hits, order: newest })
  expect(ranked.metadata.map((item) => item.key)).toEqual(["ses_title"])
  expect(ranked.transcript).toHaveLength(30)
})

test("before transcript results arrive, and after they arrive late, metadata matches keep their place", () => {
  const known = [row("ses_title", "parser bugs", 1)]
  const early = rankSearch({ query: "parser", pinned: [], known, transcriptHits: [], order: newest })
  const late = rankSearch({ query: "parser", pinned: [], known, transcriptHits: [row("ses_t", "other", 50)], order: newest })
  expect(early.metadata.map((item) => item.key)).toEqual(["ses_title"])
  expect([...late.metadata, ...late.transcript].map((item) => item.key)).toEqual(["ses_title", "ses_t"])
})

test("a row appears once: pinned, else metadata, else transcript", () => {
  const pinned = [row("ses_p", "parser pin", 5)]
  const ranked = rankSearch({ query: "parser", pinned, known: [...pinned, row("ses_m", "parser", 4)], transcriptHits: [row("ses_p", "parser pin", 5), row("ses_m", "parser", 4)], order: newest })
  expect([ranked.pinned.length, ranked.metadata.map((item) => item.key), ranked.transcript]).toEqual([1, ["ses_m"], []])
})

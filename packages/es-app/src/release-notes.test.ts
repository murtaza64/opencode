import { describe, expect, test } from "bun:test"
import { parseReleaseNotes } from "./release-notes"

const notes = (extra = {}) => ({ schema: "release-notes/1", release: "1.4.0+abc1234", items: [{ title: "Pinned reorders by drag", detail: "Alt+Up/Down too.", try: { label: "Open Agents", href: "/agents" } }], limits: ["Created sort waits for Core"], ...extra })

describe("parseReleaseNotes", () => {
  test("keeps release-notes/1 for exactly the running release", () => {
    expect(parseReleaseNotes(notes(), "1.4.0+abc1234")).toEqual({ release: "1.4.0+abc1234", items: [{ title: "Pinned reorders by drag", detail: "Alt+Up/Down too.", try: { label: "Open Agents", href: "/agents", internal: true } }], limits: ["Created sort waits for Core"] })
  })
  test("returns null for another release, another schema or no release id", () => {
    expect(parseReleaseNotes(notes(), "1.4.1+def5678")).toBeNull()
    expect(parseReleaseNotes(notes({ schema: "release-notes/2" }), "1.4.0+abc1234")).toBeNull()
    expect(parseReleaseNotes(notes(), undefined)).toBeNull()
  })
  test("keeps http(s) try links as external and drops other schemes", () => {
    const parsed = parseReleaseNotes(notes({ items: [{ title: "A", try: { label: "Docs", href: "https://example.test/x" } }, { title: "B", try: { label: "Bad", href: "javascript:alert(1)" } }, { title: "C", try: { label: "Net", href: "//evil.test" } }] }), "1.4.0+abc1234")
    expect(parsed?.items).toEqual([{ title: "A", try: { label: "Docs", href: "https://example.test/x", internal: false } }, { title: "B" }, { title: "C" }])
  })
  test("caps items at 8 and limits at 5, and drops untitled items", () => {
    const parsed = parseReleaseNotes(notes({ items: [{ detail: "no title" }, ...Array.from({ length: 10 }, (_, i) => ({ title: `T${i}` }))], limits: Array.from({ length: 7 }, (_, i) => `L${i}`) }), "1.4.0+abc1234")
    expect(parsed?.items.map(item => item.title)).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6"])
    expect(parsed?.limits).toHaveLength(5)
  })
})

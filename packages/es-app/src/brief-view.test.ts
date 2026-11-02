import { expect, test } from "bun:test"
import type { AttentionRecord } from "./attention"
import { briefSemantics, HUD, hudPages } from "./brief-view"
import { attentionItem, type BriefResult } from "./desk"

// Synthetic fixtures only: no Work brief, source or history.
const record = (extra: Partial<AttentionRecord> = {}): AttentionRecord => ({
  id: "att_1", editspace: "alpha", revision: 2, status: "open", kind: "decision", title: "Ship the cache change?", context: "Canary healthy for a day.",
  options: [{ id: "go", label: "Go ahead" }, { id: "wait", label: "Wait a week" }], recommendation: "go", producer_session: "ses_p", origin_session: "ses_p",
  gate_key: "cache", source_ref: { session_id: "ses_src", directory: "/alpha" }, decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1, ...extra,
} as AttentionRecord)
const result = (extra: Partial<BriefResult> = {}): BriefResult => ({
  question: "Turn the faster cache on for everyone?", context: "", subjects: [], commands: [], steps: [], items: [], ifWait: "", sends: "", sendsTo: "", sendsAs: "", copy: [],
  sources: [], timeline: [],
  choices: [{ id: "go", label: "Go ahead", outcome: "Everyone gets faster pages", note: "Rollback is one flag" }, { id: "wait", label: "Wait a week", outcome: "Only the canary has it", note: "" }],
  facts: [{ text: "Canary error rate unchanged for 24 h", refs: ["C1"] }], gaps: ["Cost at full traffic is not measured."], ...extra,
})
const item = (extra: Partial<AttentionRecord> = {}) => attentionItem(record(extra), 1)

test("a brief's meaning is one ordered node list: item, question, options, risks, evidence, unknowns, state", () => {
  const view = briefSemantics(item(), result(), { host: "mini", asOf: 5 })
  expect(view.item).toEqual({ key: "attention:alpha:att_1", host: "mini", revision: "2", title: "Ship the cache change?" })
  expect(view.nodes.map(node => [node.id, node.group, node.mark])).toEqual([
    ["item", "item", undefined], ["question", "question", undefined], ["option:go", "option", "recommended"], ["option:wait", "option", undefined],
    ["risk:go", "risk", undefined], ["evidence:0", "evidence", undefined], ["unknown:0", "unknown", undefined], ["state", "state", undefined]])
  expect(view.nodes.find(node => node.id === "state")!.text).toBe("open · revision 2")
})

test("a recorded answer marks its option as chosen; the recommendation stays labelled as a recommendation", () => {
  const view = briefSemantics(item({ status: "answered", answer: { choice_id: "wait" } as AttentionRecord["answer"] }), result())
  expect(view.nodes.filter(node => node.mark).map(node => [node.id, node.mark])).toEqual([["option:go", "recommended"], ["option:wait", "chosen"]])
  expect(view.nodes.at(-1)!.text).toBe("answered · answered Wait a week · revision 2")
})

test("the HUD shows the same nodes in the same order on 48-column pages with title and pager", () => {
  const view = briefSemantics(item(), result())
  const pages = hudPages(view)
  const order = pages.flatMap(page => page.lines.map(line => line.node)).filter((node, index, all) => all.indexOf(node) === index)
  expect(order).toEqual(view.nodes.filter(node => node.group !== "item" && node.group !== "state").map(node => node.id))
  for (const page of pages) {
    expect(page.lines.length).toBeLessThanOrEqual(HUD.rows - 2)
    for (const text of [page.title, page.pager, ...page.lines.map(line => line.text)]) expect(text.length).toBeLessThanOrEqual(HUD.columns)
  }
  expect(pages[0]!.title).toBe("Ship the cache change?")
  expect(pages[0]!.pager).toBe(`1/${pages.length} · open · revision 2`)
  expect(pages[0]!.lines.find(line => line.node === "option:go")!.text).toContain("Go ahead")
  expect(pages.flatMap(page => page.lines.map(line => line.text)).join("\n")).toContain("(rec)")
})

test("paging is deterministic and starts a node on a fresh page rather than splitting it when it fits one", () => {
  const view = briefSemantics(item(), result({ facts: Array.from({ length: 6 }, (_, index) => ({ text: `Fact ${index}: ${"word ".repeat(12)}`, refs: [] })) }))
  const pages = hudPages(view)
  expect(hudPages(view)).toEqual(pages)
  for (const node of new Set(pages.flatMap(page => page.lines.map(line => line.node)))) {
    const where = pages.map(page => page.lines.some(line => line.node === node))
    expect(where.filter(Boolean).length).toBe(1)
  }
})

test("a brief too dense for the glasses ends with where to read the rest, not smaller text", () => {
  const view = briefSemantics(item(), result({ facts: Array.from({ length: 40 }, (_, index) => ({ text: `Fact ${index} ${"long ".repeat(15)}`, refs: [] })) }), { host: "mini" })
  const pages = hudPages(view)
  expect(pages.length).toBe(HUD.maxPages)
  expect(pages.at(-1)!.lines.map(line => line.text).join(" ")).toContain("More on the desk: mini~attention:alpha:att_1")
  expect(pages.at(-1)!.pager).toBe(`${HUD.maxPages}/${HUD.maxPages} · open · revision 2`)
})

test("a word longer than a line is split, never overflowing the glasses", () => {
  const pages = hudPages(briefSemantics(item(), result({ gaps: ["x".repeat(130)] })))
  for (const line of pages.flatMap(page => page.lines)) expect(line.text.length).toBeLessThanOrEqual(HUD.columns)
})

test("numbered request items keep their ids and order as their own nodes and page deterministically", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: `D${index + 1}`, question: `Decision ${index + 1} about the keyboard?`, recommended: "yes", alternatives: ["no"], refs: [] }))
  const view = briefSemantics(item({ context: rows.map(row => `${row.id}. ${row.question} Recommended: yes. Alternative: no.`).join("\n") }), result({ items: rows }))
  expect(view.nodes.filter(node => node.group === "row").map(node => node.id)).toEqual(rows.map(row => `row:${row.id}`))
  expect(view.nodes.map(node => node.group).indexOf("row")).toBe(2)
  const pages = hudPages(view)
  expect(pages.length).toBeGreaterThan(1)
  expect(pages.flatMap(page => page.lines.filter(line => line.node.startsWith("row:")).map(line => line.text))[0]).toBe("D1 Decision 1 about the keyboard? → yes (or no)")
})

test("an item value the request does not quote reads as not given, as on the desktop card", () => {
  const view = briefSemantics(item({ context: "D1. Which key? Recommended: Alt." }), result({ items: [{ id: "D1", question: "Which key?", recommended: "Ctrl", alternatives: ["Super"], refs: [] }, { id: "D9", question: "Invented?", recommended: "x", alternatives: [], refs: [] }] }))
  expect(view.nodes.filter(node => node.group === "row").map(node => node.text)).toEqual(["D1 Which key? → not given"])
})

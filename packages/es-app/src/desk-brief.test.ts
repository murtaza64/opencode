import { expect, test } from "bun:test"
import { briefComplete, briefSends, detailRequest, sourceTarget, type BriefResult, type DeskItem, type EvidenceRef } from "./desk"

const item = { key: "attention:alpha:att_1", kind: "decision", title: "Pick", revision: "2", checked: 1, source: { session: "ses_src", directory: "/alpha" },
  record: { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } } as unknown as DeskItem
const refs: EvidenceRef[] = [{ id: "C1", label: "canonical" }, { id: "E1", label: "assistant", messageID: "msg_1" }, { id: "E2", label: "user", messageID: "msg_4" }]

test("a cited thread source targets the cited message range of the source thread", () => {
  expect(sourceTarget({ label: "Latency report", refs: ["E2", "E1"] }, refs)).toEqual({ kind: "thread", message: "msg_4", to: "msg_1" })
  // The request alone opens the thread the card already links.
  expect(sourceTarget({ label: "Request", refs: ["C1"] }, refs)).toBeUndefined()
})

test("a file source resolves only to a markdown doc; anything else has no destination", () => {
  expect(sourceTarget({ label: "Plan", refs: ["file:docs/plan.md"] }, refs)).toEqual({ kind: "doc", path: "docs/plan.md" })
  expect(sourceTarget({ label: "Code", refs: ["file:src/a.ts"] }, refs)).toBeUndefined()
})

test("a brief stands in for the request only with a question and every option's outcome", () => {
  const result: BriefResult = { question: "Pick A or B?", context: "", choices: [{ id: "a", label: "", outcome: "Ships", note: "" }], ifWait: "", sends: "", sources: [], facts: [], timeline: [], gaps: [] }
  expect(briefComplete(result, item)).toBe(false)
  const both = { ...result, choices: [...result.choices, { id: "b", label: "", outcome: "Waits", note: "" }] }
  expect(briefComplete(both, item)).toBe(true)
  expect(briefComplete({ ...both, question: "" }, item)).toBe(false)
})

test("text a decision would publish is shown only when quoted verbatim from the request", () => {
  const record = { ...item, record: { options: [], context: "Draft reply: 'Checked: not needed.' Rule: ask first." } } as unknown as DeskItem
  const result: BriefResult = { question: "Post it?", context: "", choices: [], ifWait: "", sends: "Checked: not needed.", sources: [], facts: [], timeline: [], gaps: [] }
  expect(briefSends(result, record)).toBe("Checked: not needed.")
  expect(briefSends({ ...result, sends: "Checked: definitely not needed." }, record)).toBe("")
})

test("a source from the original conversation opens that conversation", () => {
  const external: EvidenceRef[] = [...refs, { id: "X1", label: "jzink-duo on GitHub review", url: "https://github.com/o/r/pull/1#discussion_r2" }]
  expect(sourceTarget({ label: "Jordan's reply", refs: ["X1", "E1"] }, external)).toEqual({ kind: "url", url: "https://github.com/o/r/pull/1#discussion_r2", where: "GitHub" })
})

test("a detail request carries the question visibly and binds the evidence to the item's exact revision", () => {
  const packet = { text: "Prepare an evidence brief for the request below.\n\n[C1] Canonical request", refs }
  const link = (ref: EvidenceRef) => ref.messageID ? `/session/ses_src?message=${ref.messageID}` : "/session/ses_src"
  const asked = detailRequest(item, "  Why only writes?  ", packet, link)
  expect(asked.text).toBe("More detail: Pick\n\nWhy only writes?")
  expect(asked.context.metadata).toEqual({ source: "es-app/front-desk-detail", key: "attention:alpha:att_1\u00002\u0000Why only writes?" })
  expect(asked.context.text).toContain("attention:alpha:att_1 at revision 2")
  expect(asked.context.text).toContain("- E1: assistant -> /session/ses_src?message=msg_1")
  expect(asked.context.text).toContain("Do not answer or decide the item itself.")
  expect(asked.context.text).toContain("\n[C1] Canonical request")
  expect(asked.context.text).not.toContain("Prepare an evidence brief")
  expect(detailRequest(item, "", packet, link).text).toBe("More detail: Pick\n\nWhy does this need me, and how did it get here?")
})

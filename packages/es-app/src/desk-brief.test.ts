import { expect, test } from "bun:test"
import { briefComplete, briefCopy, briefSends, detailRequest, sourceTarget, type BriefResult, type DeskItem, type EvidenceRef } from "./desk"

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
  const result: BriefResult = { question: "Pick A or B?", context: "", choices: [{ id: "a", label: "", outcome: "Ships", note: "" }], ifWait: "", sends: "", sendsTo: "", sendsAs: "", copy: [], subjects: [], commands: [], steps: [], items: [], sources: [], facts: [], timeline: [], gaps: [] }
  expect(briefComplete(result, item)).toBe(false)
  const both = { ...result, choices: [...result.choices, { id: "b", label: "", outcome: "Waits", note: "" }] }
  expect(briefComplete(both, item)).toBe(true)
  expect(briefComplete({ ...both, question: "" }, item)).toBe(false)
})

test("text a decision would publish is shown only when quoted verbatim from the request", () => {
  const record = { ...item, record: { options: [], context: "Draft reply: 'Checked: not needed.' Rule: ask first." } } as unknown as DeskItem
  const result: BriefResult = { question: "Post it?", context: "", choices: [], ifWait: "", sends: "Checked: not needed.", sendsTo: "", sendsAs: "", copy: [], subjects: [], commands: [], steps: [], items: [], sources: [], facts: [], timeline: [], gaps: [] }
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

// Two Slack-ready posts as a producer writes them: separators, headings, blank lines, *bold*, URLs, backticks,
// and the same last line in both posts.
const POST1 = [":spring: *Spring Boot 3 upgrade* lands Monday.", "", "Pilot PRs: https://github.com/o/r/pull/1 and https://github.com/o/r/pull/2", "Run `make upgrade` locally first.", "", "Do I need to do anything? No. This is a one-time upgrade."].join("\n")
const POST2 = [":package: *Protobuf 4* follows on Wednesday.", "", "Notes: https://example.com/protobuf", "", "Do I need to do anything? No. This is a one-time upgrade."].join("\n")
const posts = { ...item, record: { options: [{ id: "posted-both", label: "Posted both" }, { id: "hold", label: "Hold" }],
  context: ["Please post these two announcements in #platform-changes. Drafts: https://example.com/posts.html", "", "===== Post 1 =====", "## Post 1", "", POST1, "", "===== Post 2 =====", "## Post 2", "", POST2, ""].join("\n") } } as unknown as DeskItem
const copyResult: BriefResult = { question: "Post the two announcements in #platform-changes, then record which you posted.", context: "",
  choices: [{ id: "posted-both", label: "", outcome: "Records that you posted both", note: "" }, { id: "hold", label: "", outcome: "Nothing is posted", note: "" }],
  ifWait: "", sends: "", sendsTo: "", sendsAs: "", subjects: [{ name: "Drafts", detail: "", refs: ["U1"] }], commands: [], steps: [], items: [], sources: [], facts: [], timeline: [], gaps: [],
  copy: [{ label: "Spring Boot", to: "#platform-changes", start: ":spring: *Spring Boot 3 upgrade*", end: "No. This is a one-time upgrade." },
    { label: "Protobuf", to: "#platform-changes", start: ":package: *Protobuf 4*", end: "No. This is a one-time upgrade." }] }

test("each copy block is the exact source text of its own post, even when both posts end with the same line", () => {
  const copy = briefCopy(copyResult, posts)
  expect(copy.blocks.map(block => block.text)).toEqual([POST1, POST2])
  expect(copy.blocks.map(block => block.label)).toEqual(["Spring Boot", "Protobuf"])
  expect(copy.quoteFailed).toBe(false)
})

test("copy anchors that span the separator and heading lines still copy only the post body", () => {
  const wide = { ...copyResult, copy: [{ label: "Spring Boot", to: "", start: "===== Post 1 =====", end: "No. This is a one-time upgrade." }] }
  expect(briefCopy(wide, posts).blocks.map(block => block.text)).toEqual([POST1])
})

test("a start anchor that occurs twice is not guessed: the block is dropped and the loss is reported", () => {
  const copy = briefCopy({ ...copyResult, copy: [{ ...copyResult.copy[0]!, start: "Do I need to do anything?" }, copyResult.copy[1]!] }, posts)
  expect(copy.blocks.map(block => block.label)).toEqual(["Protobuf"])
  expect(copy.quoteFailed).toBe(true)
})

test("an end that appears only after the next block's start fails that block", () => {
  const copy = briefCopy({ ...copyResult, copy: [{ ...copyResult.copy[0]!, end: "Notes: https://example.com/protobuf" }, copyResult.copy[1]!] }, posts)
  expect(copy.blocks.map(block => block.label)).toEqual(["Protobuf"])
  expect(copy.quoteFailed).toBe(true)
})

test("two blocks starting at the same place overlap, and neither is shown", () => {
  const copy = briefCopy({ ...copyResult, copy: [copyResult.copy[0]!, { ...copyResult.copy[0]!, label: "Again" }] }, posts)
  expect(copy.blocks).toEqual([])
  expect(copy.quoteFailed).toBe(true)
})

test("a sends text the model re-typed (blank lines collapsed) is reported as lost, not dropped silently", () => {
  const retyped = { ...copyResult, copy: [], sends: POST1.replace(/\n\n/g, "\n") }
  expect(briefSends(retyped, posts)).toBe("")
  expect(briefCopy(retyped, posts).quoteFailed).toBe(true)
  expect(briefCopy({ ...retyped, sends: POST1 }, posts).quoteFailed).toBe(false)
})

test("links inside a copied post need no subject row; the drafts link is the brief's own subject", () => {
  expect(briefComplete(copyResult, posts)).toBe(true)
  expect(briefComplete({ ...copyResult, copy: [copyResult.copy[1]!] }, posts)).toBe(false)
})

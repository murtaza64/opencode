import { expect, test } from "bun:test"
import { completeBriefJob } from "./desk-session"
import { attentionItem, type BriefResult } from "./desk"
import type { AttentionRecord } from "./attention"
import type { BriefJob } from "./desk-session"

const record = { id: "decision_1", editspace: "fixture", revision: 3, content_revision: 2, kind: "decision", title: "Rotate certs?",
  context: "", options: [{ id: "now", label: "Now" }], source_ref: { session_id: "ses_m", directory: "/mini" } } as AttentionRecord
const result: BriefResult = { question: "Rotate before Friday?", context: "", subjects: [], choices: [{ id: "now", label: "Now", outcome: "Rotated", note: "" }],
  commands: [], steps: [], items: [], ifWait: "", sends: "", sendsTo: "", sendsAs: "", copy: [], sources: [], facts: [], timeline: [], gaps: [] }
const job: BriefJob = { id: "ses_fdjob_mini", directory: "/mini", created: 1,
  meta: { kind: "brief", requestID: "mini", source: "attention:fixture:decision_1", revision: "2", title: "Rotate certs?", refs: [], contract: 4 },
  state: { state: "ready", result, omitted: 0 } }

test("a host brief is shown only for the exact content revision and a complete ready result", () => {
  expect(completeBriefJob([job], attentionItem(record, 0))?.id).toBe(job.id)
  expect(completeBriefJob([job], attentionItem({ ...record, content_revision: 4 }, 0))).toBeUndefined()
  expect(completeBriefJob([{ ...job, state: { state: "running" } }], attentionItem(record, 0))).toBeUndefined()
  expect(completeBriefJob([{ ...job, state: { state: "ready", result: { ...result, choices: [] }, omitted: 0 } }], attentionItem(record, 0))).toBeUndefined()
})

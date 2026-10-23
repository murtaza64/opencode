import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { MessageWithParts } from "./api"
import type { AttentionRecord } from "./attention"
import { BRIEF_SCHEMA, BRIEF_SYSTEM, briefPacket, deskItems } from "./desk"
import { BRIEF_PERMISSION, briefAnchorID, briefID } from "./desk-session"

// The es-dashboard starts the same brief jobs when no client is open
// (murtaza64/dotfiles bin/es_dashboard_frontdesk.py, tests/test_es_dashboard_frontdesk.py).
// Both sides assert these values; changing the prompt, schema, permissions, packet or IDs here
// requires the same change there, or one side would start differently worded duplicate jobs.
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

test("brief prompt contract matches the dashboard copy", () => {
  expect(sha(JSON.stringify([`${BRIEF_SYSTEM}\n${JSON.stringify(BRIEF_SCHEMA)}`, BRIEF_PERMISSION])))
    .toBe("29e0e501ac23978929f0de22c26fc70490d9eceff53ad1a0aef9872c3f60207d")
})

test("brief anchor and job IDs match the dashboard's", async () => {
  expect(await briefAnchorID("/alpha root/é")).toBe("ses_fdbrief_2027bc82e015b708d3dd")
  expect(await briefID("ses_fdbrief_x", "attention:alpha:att_1", "2", 0)).toBe("ses_fdjob_ac137c3dc896f5776ead19cc")
})

test("brief packet for an attention record matches the dashboard's", () => {
  const record: AttentionRecord = {
    id: "att_1", editspace: "alpha", revision: 3, status: "open", kind: "decision", title: "Pick a rollout — café",
    context: `Two   options\nremain. ${"x".repeat(2100)}`, options: [{ id: "a", label: "Canary" }, { id: "b", label: "Full" }],
    recommendation: "a", producer_session: "ses_p", origin_session: "ses_p", gate_key: "rollout",
    source_ref: { session_id: "ses_src", directory: "/alpha" }, decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1,
  }
  const item = deskItems({ records: [record], attentionChecked: 0, requests: [], failures: [], failuresChecked: 0, title: () => undefined, project: () => undefined })[0]!
  const tail = [
    { info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "Roll it out?" }, { type: "text", text: "hidden", synthetic: true }] },
    { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "tool", tool: "bash", state: { status: "completed" } }, { type: "text", text: `Canary is healthy. ${"y".repeat(600)}` }] },
    { info: { id: "msg_3", role: "assistant" }, parts: [{ type: "reasoning", text: "skip" }] },
  ] as unknown as MessageWithParts[]
  const thread = { kind: "github-review" as const, repo: "o/r", number: 7, path: "w.yaml", line: 38, url: "https://github.com/o/r/pull/7#discussion_r1",
    comments: [{ author: "codex[bot]", bot: true, when: "2026-10-19T18:36:06Z", body: "Forward the password", url: "https://github.com/o/r/pull/7#discussion_r1" },
      { author: "jzink-duo", bot: false, when: "2026-10-22T17:41:16Z", body: "seems legit enough; check if true and fix", url: "https://github.com/o/r/pull/7#discussion_r2" }] }
  const packet = briefPacket(item, tail, [thread])
  expect(sha(JSON.stringify([packet.text, packet.refs]))).toBe("c2cc6c23d832e3ee2b171976ab0b3cfb2109d44f9e63c1c5d6f1cbb7f3de50eb")
})

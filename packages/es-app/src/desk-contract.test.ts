import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { MessageWithParts } from "./api"
import type { AttentionRecord } from "./attention"
import { BRIEF_SCHEMA, BRIEF_SYSTEM, briefPacket, deskItems } from "./desk"
import contract from "./brief-contract.json"
import { BRIEF_PERMISSION, DESK_MODEL, briefAnchorID, briefID } from "./desk-session"

// The es-dashboard starts the same brief jobs when no client is open
// (murtaza64/dotfiles bin/es_dashboard_frontdesk.py, tests/test_es_dashboard_frontdesk.py).
// Both sides assert these values; changing the prompt, schema, permissions, packet or IDs here
// requires the same change there, or one side would start differently worded duplicate jobs.
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

test("brief prompt contract matches the dashboard copy", () => {
  expect(sha(JSON.stringify([`${BRIEF_SYSTEM}\n${JSON.stringify(BRIEF_SCHEMA)}`, BRIEF_PERMISSION])))
    .toBe("b8c2827af9943a77eb377950e820e82a2c559c203ce71e974787153d6ec24c49")
})

test("the whole brief contract file (drawing rules and tokens too) matches the dashboard's copy", () => {
  expect(sha(JSON.stringify(contract))).toBe("545a37bd9d1e394e11bb670707a8b1d5034c8f1b559a06ec1ee52bfd719937f9")
})

test("briefs run on the same explicit model as the dashboard's", () => {
  expect(DESK_MODEL).toEqual({ providerID: "duolingo-openai", modelID: "gpt-6.1-sol" })
})

test("brief anchor and job IDs match the dashboard's", async () => {
  expect(await briefAnchorID("/alpha root/é")).toBe("ses_fdbrief_2027bc82e015b708d3dd")
  expect(await briefID("ses_fdbrief_x", "attention:alpha:att_1", "2", 0)).toBe("ses_fdjob_ac137c3dc896f5776ead19cc")
})

test("brief packet for an attention record matches the dashboard's", () => {
  const record: AttentionRecord = {
    id: "att_1", editspace: "alpha", revision: 3, status: "open", kind: "decision", title: "Pick a rollout — café",
    context: `Two   options\nremain. See https://github.com/o/r/pull/7 and https://github.com/o/r/pull/8. ${"x".repeat(6100)} https://github.com/o/r/pull/9`,
    options: [{ id: "a", label: "Canary" }, { id: "b", label: "Full", input: { kind: "text", label: "Reviewers", required: true } }],
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
  expect(sha(JSON.stringify([packet.text, packet.refs]))).toBe("b24c56abf8947a73d67e1df5da71e83811701d3ea1fd70b635b87e38e98793be")
})

test("brief packet with a Slack thread and a named document matches the dashboard's", () => {
  const record = { id: "att_9", editspace: "alpha", revision: 1, status: "open", kind: "decision", title: "Ask the owners?", context: "Draft: draft.txt",
    options: [{ id: "post", label: "Post" }], recommendation: "post", producer_session: "ses_p", origin_session: "ses_p", gate_key: "g",
    source_ref: { session_id: "ses_src", directory: "/alpha" }, decision: null, delivery_state: "not-requested", created_at: 1, updated_at: 1 } as AttentionRecord
  const item = deskItems({ records: [record], attentionChecked: 0, requests: [], failures: [], failuresChecked: 0, title: () => undefined, project: () => undefined })[0]!
  const thread = { kind: "slack-thread" as const, channel: "C1", url: "https://ws.slack.com/archives/C1/p1792439040168029", comments: [
    { author: "Ann", bot: false, when: "2026-10-19T19:44:00.168Z", body: "CPU went up", url: "https://ws.slack.com/archives/C1/p1792439040168029" },
    { author: "Bo", bot: false, when: "2026-10-19T19:51:53.000Z", body: "peak traffic", url: "https://ws.slack.com/archives/C1/p1792439513325629?thread_ts=1792439040.168029" }] }
  const packet = briefPacket(item, [], [thread], [{ name: "draft.txt", text: "Who owns the audio contract?" }])
  expect(sha(JSON.stringify([packet.text, packet.refs]))).toBe("6b01383a97e320647f0452bb331a78cf1b87bd8339ea45aacb89981659e2665b")
})

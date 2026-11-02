import { expect, test } from "bun:test"
import type { MailDelivery, MailMessage, MailTimeline } from "./api"
import { caseLines, followUps, progressRows, type DeskCase } from "./desk-followups"

const delivery = (state: string): MailDelivery => ({ message_id: "x", recipient: "alpha", session: "ses_alpha", mode: "actionable", state, request_id: "r", error: null, presented_at: null, handled_at: null })
const mail = (id: string, extra: Partial<MailMessage>): MailMessage =>
  ({ id, ts: "2026-10-28T10:00:00Z", created_ms: 1_000, from: "ses_desk", to: "alpha", direction: "sent", deliveries: [], text: id, ...extra })
const timeline = (messages: MailMessage[]): MailTimeline => ({ editspace: "proj", lane: "", messages })

test("each question the desk sent shows its owner, delivery and the owner's first reply", () => {
  const items = followUps(timeline([
    mail("alpha#1", { kind: "question", sender_session: "ses_desk", text: "Which build?", created_ms: 1_000, deliveries: [delivery("handled")] }),
    mail("alpha#2", { kind: "answer", sender_session: "ses_alpha", from: "alpha", to: "ses_desk", in_reply_to: "alpha#1", text: "Build 42", created_ms: 2_000 }),
    mail("beta#1", { kind: "question", sender_session: "ses_desk", to: "beta", text: "Is it green?", created_ms: 3_000, deliveries: [delivery("admitted")] }),
  ]), "ses_desk")
  expect(items.map(item => [item.id, item.owner, item.delivery, item.answer?.text])).toEqual([["beta#1", "beta", "delivered", undefined], ["alpha#1", "alpha", "seen", "Build 42"]])
})

test("a question without any delivery receipt reads as unknown, not as sent", () => {
  expect(followUps(timeline([mail("alpha#1", { kind: "question", sender_session: "ses_desk" })]), "ses_desk")[0]!.delivery).toBe("unknown")
})

test("mail the desk did not ask, and its own notes, are not follow-ups", () => {
  const items = followUps(timeline([
    mail("alpha#1", { kind: "notice", sender_session: "ses_desk" }),
    mail("alpha#2", { kind: "question", sender_session: "ses_other" }),
    mail("alpha#3", { kind: "question", sender_session: "ses_desk", deliveries: [delivery("failed")] }),
    mail("alpha#4", { kind: "answer", sender_session: "ses_desk", in_reply_to: "alpha#3" }),
  ]), "ses_desk")
  expect(items.map(item => [item.id, item.delivery, item.answer])).toEqual([["alpha#3", "failed", undefined]])
})

test("a case reaches the desk's context as owners, limits and read-back state, with no authority claimed", () => {
  const lines = caseLines([{ case_id: "two-parts", title: "Directions and a workspace", privacy: "metadata only", updated: 1,
    intents: [{ id: "private-read", state: "working", owner: { lane: "exploration", editspace: "directions", host: "mini", session: "ses_private000001" }, fallback: "laptop reader excerpt", not_granted: ["share notes"] },
      { id: "workspace", state: "delivered", owner: { lane: "project-lead", editspace: "streams", host: "mini" } }],
    deliverables: [{ id: "deck", intent: "workspace", label: "Explainer deck", ref: "http://127.0.0.1:64924/", read_back: true }, { id: "report", intent: "private-read", label: "Private report" }] }])
  expect(lines[0]).toContain("never authorization")
  expect(lines).toContain("  - private-read [working] owner exploration in directions on mini (ses_private000001) · fallback: laptop reader excerpt · not granted: share notes")
  expect(lines).toContain("  - deliverable Explainer deck http://127.0.0.1:64924/ · read back")
  expect(lines).toContain("  - deliverable Private report · not read back yet")
  expect(caseLines([])).toEqual([])
})

test("the strip puts what needs the human first, then work under way, then what waits on owners, then results, with ids only in detail", () => {
  const now = 10 * 86_400_000
  const cases = [{ case_id: "reports-and-streams", title: "Directions and streams", updated: now - 1_000,
    intents: [{ id: "private-project-directions", state: "delivered", state_at: now - 2_000, owner: { lane: "exploration", editspace: "directions", host: "mini", session: "ses_private000001" } },
      { id: "diff-streams-discovery", state: "working", next: "native views", state_at: now - 9_000 }, { id: "choose-scope", state: "waiting", needs: { action: "answer" as const, label: "Pick the first workspace", ref: "attention:streams:rec-1" } }, { id: "dropped", state: "withdrawn" }],
    deliverables: [{ id: "report", intent: "private-project-directions", label: "Directions report", ref: "http://127.0.0.1:1/report", read_back: true, read_back_at: now - 1_500 }] }]
  const rows = progressRows(cases, [{ editspace: "p", id: "a#1", owner: "alpha", text: "Which build?", asked: now - 5_000, delivery: "delivered" }])
  expect(rows.map(row => [row.group, row.label, row.status])).toEqual([
    ["needs", "Choose scope", "Pick the first workspace"],
    ["working", "Diff streams discovery", "native views"],
    ["waiting", "Which build?", "Asked alpha"],
    ["result", "Private project directions", "Delivered"]])
  expect(rows[3]!.link).toEqual({ label: "Directions report", href: "http://127.0.0.1:1/report" })
  expect(rows[3]!.readBackAt).toBe(now - 1_500)
  expect(rows[3]!.detail).toContain("ses_private000001")
  expect(rows.map(row => row.label).join(" ")).not.toContain("ses_")
})

test("completed parts and answers stay listed after a day, newest first, with undated ones last", () => {
  const day = 86_400_000
  const cases: DeskCase[] = [{ case_id: "old-case", updated: 1, intents: [{ id: "undated", state: "done" }, { id: "last-week", state: "delivered", state_at: 3 * day }], deliverables: [] },
    { case_id: "recent-case", updated: 1, intents: [{ id: "yesterday", state: "done", state_at: 9 * day }], deliverables: [] }]
  const answered = { editspace: "p", id: "a#1", owner: "alpha", text: "Old question", asked: day, delivery: "seen" as const, answer: { id: "a#2", at: 5 * day, text: "yes" } }
  expect(progressRows(cases, [answered]).map(row => [row.group, row.label, row.at])).toEqual([
    ["result", "Yesterday", 9 * day], ["result", "Old question", 5 * day], ["result", "Last week", 3 * day], ["result", "Undated", undefined]])
})

test("a part's age comes only from its own state change time, never from the case's update time", () => {
  const rows = progressRows([{ case_id: "c", updated: 123_456, intents: [{ id: "dated", state: "working", state_at: 100 }, { id: "undated", state: "working" }], deliverables: [] }], [])
  expect(rows.map(row => [row.label, row.at])).toEqual([["Dated", 100], ["Undated", undefined]])
})

test("a state the desk does not recognise shows as unknown, not as work", () => {
  const rows = progressRows([{ case_id: "c", updated: 1, intents: [{ id: "odd", state: "paused" }, { id: "plain" }], deliverables: [] }], [])
  expect(rows.map(row => [row.group, row.label, row.status])).toEqual([["waiting", "Plain", "Not started (requested)"], ["unknown", "Odd", "Unknown state: paused"]])
})

test("each case state lands in one group: working is work, not-yet-started and blocked parts wait on owners", () => {
  const states = ["requested", "routed", "acknowledged", "working", "waiting", "delivered", "done", "withdrawn", "paused"]
  const rows = progressRows([{ case_id: "c", updated: 1, deliverables: [], intents: states.map(state => ({ id: state, state })) }], [])
  expect(Object.fromEntries(rows.map(row => [row.key.split("/")[1], row.group]))).toEqual({
    requested: "waiting", routed: "waiting", acknowledged: "waiting", working: "working", waiting: "waiting", delivered: "result", done: "result", paused: "unknown" })
})

test("a question the desk asked an owner waits on that owner until answered", () => {
  const rows = progressRows([], [{ editspace: "p", id: "a#1", owner: "alpha", text: "Which build?", asked: 5, delivery: "seen" }])
  expect(rows.map(row => [row.group, row.status])).toEqual([["waiting", "Asked alpha"]])
})

test("only a working part counts as work; a part its owner has not started waits on that owner", () => {
  const rows = progressRows([{ case_id: "c", updated: 1, deliverables: [],
    intents: [{ id: "busy", state: "working" }, { id: "asked", state: "requested" }, { id: "sent", state: "routed" }, { id: "seen", state: "acknowledged", next: "Starts after review" }] }], [])
  expect(rows.map(row => [row.group, row.label, row.status])).toEqual([
    ["working", "Busy", "In progress"], ["waiting", "Asked", "Not started (requested)"], ["waiting", "Sent", "Not started (routed)"], ["waiting", "Seen", "Starts after review"]])
})

test("a row names who has it and flags a blocker: an unrecognised state or a question without a delivery receipt", () => {
  const rows = progressRows([{ case_id: "c", updated: 1, deliverables: [], intents: [{ id: "odd", state: "paused", owner: { lane: "tour" } }, { id: "plain", state: "working" }] }],
    [{ editspace: "p", id: "a#1", owner: "alpha", text: "No receipt", asked: 3, delivery: "unknown" }, { editspace: "p", id: "a#2", owner: "beta", text: "Bounced", asked: 2, delivery: "failed" },
      { editspace: "p", id: "a#3", owner: "gamma", text: "Fine", asked: 1, delivery: "delivered" }])
  expect(rows.map(row => [row.label, row.owner, row.flag])).toEqual([
    ["Plain", undefined, undefined], ["No receipt", "alpha", "no receipt"], ["Bounced", "beta", "not delivered"], ["Fine", "gamma", undefined], ["Odd", "tour", "paused"]])
})

test("a waiting part needs the human only with a recorded action, which links to where it is done", () => {
  const rows = progressRows([{ case_id: "c", updated: 1, deliverables: [], intents: [
    { id: "decide", state: "waiting", needs: { action: "answer", label: "Choose the rollout", ref: "attention:alpha:rec-9" } },
    { id: "try-it", state: "waiting", needs: { action: "try", label: "Try the editor", ref: "surface:vim-editor" } },
    { id: "read", state: "waiting", needs: { action: "review", label: "Read the report", ref: "https://example.test/report" } },
    { id: "elsewhere", state: "waiting", needs: { action: "do", label: "Plug in the TV" } },
  ] }], [])
  expect(rows.map(row => [row.group, row.label, row.status, row.link])).toEqual([
    ["needs", "Decide", "Choose the rollout", { label: "Answer", href: "/?item=attention%3Aalpha%3Arec-9" }],
    ["needs", "Try it", "Try the editor", { label: "Try it", href: "/?surface=vim-editor" }],
    ["needs", "Read", "Read the report", { label: "Review", href: "https://example.test/report" }],
    ["needs", "Elsewhere", "Plug in the TV", undefined]])
})

test("a waiting part with no recorded action is its owner's blocker, not a question for the human", () => {
  const rows = progressRows([{ case_id: "c", updated: 1, deliverables: [], intents: [
    { id: "upgrade", state: "waiting", next: "client guard rejects the current target", owner: { lane: "personal-upgrade" } }, { id: "bare", state: "waiting" }] }], [])
  expect(rows.map(row => [row.group, row.status, row.flag])).toEqual([
    ["waiting", "Blocked: client guard rejects the current target", "blocked"], ["waiting", "Blocked; no action for you recorded", "blocked"]])
})

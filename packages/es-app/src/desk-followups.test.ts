import { expect, test } from "bun:test"
import type { MailDelivery, MailMessage, MailTimeline } from "./api"
import { caseLines, followUps, visibleFollowUps } from "./desk-followups"

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

test("open questions stay listed; answers older than a day fold into a count, never vanish", () => {
  const open = { editspace: "p", id: "a#1", owner: "a", text: "", asked: 0, delivery: "seen" as const }
  const recent = { ...open, id: "a#2", answer: { id: "a#3", at: 90_000_000, text: "" } }
  const old = { ...open, id: "a#4", answer: { id: "a#5", at: 1_000, text: "" } }
  const result = visibleFollowUps([recent, old, open], 100_000_000)
  expect(result.shown.map(item => item.id)).toEqual(["a#1", "a#2"])
  expect(result.earlier.map(item => item.id)).toEqual(["a#4"])
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

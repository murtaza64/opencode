import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import type { MailMessage, MailTimeline } from "./api"
import { mailActivityLabel, mailCauses, mailForSession, mailLocation, mailRows, mailWake } from "./mail-timeline"

test("selects the matching editspace and lane from the session directory", () => {
  const roots = [
    { name: "other", root: "/work" },
    { name: "correct", root: "/work/project/.editspace" },
  ]
  expect(mailLocation("/work/project/.editspace/lanes/alpha/repos/org/repo", roots)).toEqual({ name: "correct", lane: "alpha" })
  expect(mailLocation("/work/project/.editspace/lanes/alpha-extra", roots)).toEqual({ name: "correct", lane: "alpha-extra" })
  expect(mailLocation("/work/project/repos/org/repo", roots)).toBeUndefined()
  expect(mailLocation("/work/project", roots, "ses_parent")).toEqual({ name: "correct", session: "ses_parent" })
  expect(mailLocation("/work/project/src", roots, "ses_independent")).toEqual({ name: "correct", session: "ses_independent" })
  expect(mailLocation("/work/project/.editspace", roots, "ses_history")).toEqual({ name: "correct", session: "ses_history" })
  expect(mailLocation("/work/project/.editspace/repos/org/repo", roots, "ses_history")).toEqual({ name: "correct", session: "ses_history" })
  expect(mailLocation("/work/project-other", [roots[1]], "ses_history")).toBeUndefined()
})

test("sorts mail alongside transcript messages and deduplicates only structured promoted source ids", () => {
  const messages = [
    { id: "msg_1", role: "user", time: { created: 1000 } },
    { id: "msg_2", role: "user", time: { created: 3000 }, source: { type: "editspace-mail", id: "mail_2", sender: "alpha", recipient: "beta" } },
    { id: "msg_3", role: "user", time: { created: 4000 }, source: { type: "other", id: "mail_3" } },
  ] as Message[]
  const timeline: MailTimeline = { editspace: "fixture", lane: "alpha", messages: [
    { id: "mail_2", ts: 2000, from: "alpha", to: "beta", text: "promoted", direction: "sent", deliveries: [] },
    { id: "mail_3", ts: 2500, from: "beta", to: "alpha", text: "received", direction: "received", deliveries: [
      { message_id: "mail_3", recipient: "alpha", session: "ses_a", mode: "queue", state: "read", request_id: "req-1", error: null, presented_at: null, handled_at: null },
    ] },
  ] }
  const rows = mailRows(messages, timeline)
  expect(rows.map((row) => row.message.id)).toEqual(["msg_1", "mail_3", "msg_2", "msg_3"])
  expect(rows[2]).toMatchObject({ type: "transcript", timestamp: 3000 })
  expect(rows[1]).toMatchObject({ type: "mail", message: { direction: "received", deliveries: [{ recipient: "alpha", state: "read" }] } })
  expect(mailRows(messages, timeline, rows)[0]).toBe(rows[0])
  expect(mailRows(messages, timeline, rows)[2]).toBe(rows[2])
  expect(mailRows(messages, structuredClone(timeline), rows)[1]).toBe(rows[1])
  const updated = mailRows(messages, { ...timeline, messages: timeline.messages.map((message) => message.id === "mail_3"
    ? { ...message, deliveries: [{ ...message.deliveries[0], state: "handled" }] } : message) }, rows)
  expect(updated[1]).toMatchObject({ type: "mail", message: { deliveries: [{ state: "handled" }] } })
  expect(updated[1]).not.toBe(rows[1])
})

test("scopes a shared lane feed by original send time even with delayed receipts", () => {
  const delivery = { message_id: "", recipient: "alpha", mode: "queue", state: "read", request_id: null, error: null, presented_at: null, handled_at: null }
  const messages: MailMessage[] = [
    { id: "old-received", ts: 1000, from: "beta", to: "alpha", direction: "received", text: "", deliveries: [{ ...delivery, message_id: "old-received", session: "ses_old" }] },
    { id: "old-sent", ts: 1500, from: "alpha", to: "beta", direction: "sent", sender_session: "ses_old", text: "", deliveries: [] },
    { id: "pending-before", ts: 1800, from: "beta", to: "alpha", direction: "received", text: "", deliveries: [{ ...delivery, message_id: "pending-before", session: null, state: "pending" }] },
    { id: "new-received", ts: 1900, from: "beta", to: "alpha", direction: "received", text: "", deliveries: [
      { ...delivery, message_id: "new-received", recipient: "gamma", session: "ses_gamma" },
      { ...delivery, message_id: "new-received", session: "ses_new", presented_at: 2100 },
    ] },
    { id: "new-sent", ts: 2500, from: "alpha", to: "beta", direction: "sent", text: "", deliveries: [] },
    { id: "late-presented", ts: 1950, from: "beta", to: "alpha", direction: "received", text: "", deliveries: [{ ...delivery, message_id: "late-presented", session: null, presented_at: 2200 }] },
  ]
  const old = mailForSession(messages, { sessionID: "ses_old", lane: "alpha", to: 2000 })
  expect(old.map((message) => message.id)).toEqual(["old-received", "old-sent", "pending-before", "late-presented"])
  const next = mailForSession(messages, { sessionID: "ses_new", lane: "alpha", from: 2000 })
  expect(next.map((message) => message.id)).toEqual(["new-sent"])
  expect(mailForSession(messages, { sessionID: "ses_new" }).map((message) => message.id))
    .toEqual(["pending-before", "new-received", "new-sent", "late-presented"])
})

test("never infers execution wake from task intent, admission, presentation, handling or failure", () => {
  const receipt = { message_id: "m", recipient: "alpha", session: "ses_a", mode: "actionable", state: "admitted", request_id: null, error: null, presented_at: null, handled_at: null }
  expect(mailWake(receipt)).toBe("Wake/resume unknown")
  expect(mailWake({ ...receipt, state: "presented" })).toBe("Wake/resume unknown")
  expect(mailWake({ ...receipt, state: "handled" })).toBe("Wake/resume unknown")
  expect(mailWake({ ...receipt, state: "failed", error: "lost response" })).toBe("Wake/resume unknown")
  expect(mailWake({ ...receipt, mode: "passive" })).toBe("Did not wake · passive")
  expect(mailWake()).toBe("Wake/resume unknown")
  expect(mailWake({ ...receipt, wake_observations: [{ outcome: "scheduled", observedAt: 1000 }] })).toBe("Execution scheduled")
  expect(mailWake({ ...receipt, wake_observations: [{ outcome: "coalesced", observedAt: 2000 }] })).toBe("Coalesced · already active")
  expect(mailWake({ ...receipt, wake_observations: [{ outcome: "scheduled", observedAt: NaN }] })).toBe("Wake/resume unknown")
  expect(mailWake({ ...receipt, wake_observations: [{ outcome: "scheduled", observedAt: 1e308 }] })).toBe("Wake/resume unknown")
  expect(mailWake({ ...receipt, mode: "passive", wake_observations: [{ outcome: "scheduled", observedAt: 1000 }] })).toBe("Execution scheduled")
  expect(mailWake({ ...receipt, wake_observations: [{ outcome: "scheduled", observedAt: 2000 }, { outcome: "coalesced", observedAt: 1000 }] })).toBe("Execution scheduled")
})

test("first sessions exclude old, invalid and missing source times despite matching receipt session", () => {
  const receipt = { message_id: "old", recipient: "alpha", session: "ses_first", mode: "actionable", state: "handled", request_id: null, error: null, presented_at: 4000, handled_at: 5000 }
  const messages = [1000, 2000, 3000, "invalid", undefined].map((ts, index) => ({
    id: `mail-${index}`, ts, from: "beta", to: "alpha", direction: "received", text: "body", deliveries: [receipt],
  })) as MailMessage[]
  expect(mailForSession(messages, { sessionID: "ses_first", lane: "alpha", from: 2000, to: 3000 }).map(message => message.id)).toEqual(["mail-1"])
  expect(mailForSession(messages, { sessionID: "ses_first", from: NaN })).toEqual([])
  expect(mailForSession(messages, { sessionID: "ses_first", from: Number.POSITIVE_INFINITY })).toEqual([])
})

test("hides historical promoted mail without rewriting raw history or giving it admission time", () => {
  const messages = [{ id: "promoted", role: "user", time: { created: 4000 }, source: {
    type: "editspace-mail", id: "old", sender: "beta", recipient: "alpha",
  } }] as Message[]
  const timeline: MailTimeline = { editspace: "fixture", lane: "alpha", messages: [
    { id: "old", ts: 1000, from: "beta", to: "alpha", direction: "received", text: "old", deliveries: [] },
  ] }
  expect(mailRows(messages, timeline, [], { sessionID: "ses_first", from: 2000 })).toEqual([])
  expect(messages).toHaveLength(1)
  expect(mailRows(messages, undefined, [], { sessionID: "ses_first", from: 2000 })).toEqual([])
})

test("precise new source time includes first-second mail but never rounds legacy time forward", () => {
  const base: MailMessage = { id: "new", ts: "2026-10-13T12:00:00Z", from: "beta", to: "alpha", direction: "received", text: "", deliveries: [] }
  const start = Date.parse(base.ts as string) + 500
  const messages = [
    { ...base, id: "precise-after", created_ms: start + 1 },
    { ...base, id: "precise-equal", created_ms: start },
    { ...base, id: "precise-before", created_ms: start - 1 },
    { ...base, id: "legacy-uncertain" },
    { ...base, id: "invalid", created_ms: NaN },
  ]
  expect(mailForSession(messages, { sessionID: "ses_first", from: start }).map(message => message.id)).toEqual(["precise-after", "precise-equal"])
  expect(mailRows([], { editspace: "fixture", lane: "alpha", messages }, [], { sessionID: "ses_first", from: start })[0].timestamp).toBe(start)
})

test("all durable loop sends render once with provenance even alongside a failed shell", () => {
  const messages = [{ id: "assistant", role: "assistant", time: { created: 2000 }, error: { name: "shell-failed" } }] as unknown as Message[]
  const timeline: MailTimeline = { editspace: "fixture", lane: "alpha", messages: [1, 2, 3, 4].map(index => ({
    id: `sent-${index}`, ts: 2000 + index, from: "orchestrator", to: `lane-${index}`, direction: "sent", text: "real durable send",
    sender_session: "ses_sender", origin_run: "run", origin_tool_call: "loop", deliveries: [],
  })) }
  const interval = { sessionID: "ses_sender", from: 1000 }
  const rows = mailRows(messages, timeline, [], interval)
  expect(rows.map(row => row.message.id)).toEqual(["assistant", "sent-1", "sent-2", "sent-3", "sent-4"])
  expect(rows[0].message).toBe(messages[0])
  expect(mailRows(messages, timeline, rows, interval)).toEqual(rows)
  expect(mailRows(messages, { ...timeline, messages: timeline.messages.slice(0, 2) }, [], interval).map(row => row.message.id)).toEqual(["assistant", "sent-1", "sent-2"])
  expect(mailRows(messages, timeline, [], { ...interval, sessionID: "ses_unrelated" }).map(row => row.message.id)).toEqual(["assistant"])
})

test("summarizes mail that was one provider turn's input, keyed before the assistant it caused", () => {
  const mail = (id: string, created: number, sender: string, extra: object = {}) =>
    ({ id: `msg_${id}`, role: "user", time: { created },
      source: { type: "editspace-mail", id, sender, recipient: "orchestrator", kind: "task", ...extra } })
  const messages = [
    { id: "msg_human", role: "user", time: { created: 1_000 } },
    { id: "msg_reply", role: "assistant", parentID: "msg_human", time: { created: 1_100 } },
    mail("o#417", 9_000, "ses_front"),
    mail("o#427", 9_001, "ux-feel"),
    mail("o#428", 9_002, "ux-feel", { relationship: "handoff-catch-up" }),
    { id: "msg_turn", role: "assistant", parentID: "msg_o#428", time: { created: 9_100 } },
    mail("o#430", 12_000, "human", { kind: "answer" }),
    { id: "msg_answer_turn", role: "assistant", parentID: "msg_o#430", time: { created: 12_100 } },
  ] as Message[]
  const received = (id: string, created_ms: number, from: string, kind = "task"): MailMessage =>
    ({ id, ts: "", created_ms, from, to: "orchestrator", kind, text: id, direction: "received", deliveries: [] })
  const records = [received("o#417", 2_000, "ses_front"), received("o#427", 5_000, "ux-feel"),
    received("o#428", 6_000, "ux-feel"), received("o#430", 11_000, "human", "answer")]
  const rows = mailRows(messages, { editspace: "fixture", lane: "orchestrator", messages: records })

  // The mails sit at their promotion point, after the earlier human exchange.
  expect(rows.map((row) => row.message.id)).toEqual(messages.map((message) => message.id))
  const causes = mailCauses(rows, new Map(records.map((record) => [record.id, record])))
  expect([...causes.keys()]).toEqual(["msg_o#428", "msg_o#430"])
  expect(causes.get("msg_o#428")).toEqual({
    ids: ["o#417", "o#427", "o#428"],
    kinds: [{ kind: "task", human: false, catchUp: false, count: 2 }, { kind: "task", human: false, catchUp: true, count: 1 }],
    senders: ["ses_front", "ux-feel"],
    senderSessions: {},
    sentFrom: 2_000,
    sentTo: 6_000,
    promotedAt: 9_000,
  })
  expect(causes.get("msg_o#430")).toMatchObject({ ids: ["o#430"], kinds: [{ kind: "answer", human: true, count: 1 }] })
})

test("no turn boundary, no cause: pending mail and mail followed by a human prompt are not summarized", () => {
  const mail = (id: string, created: number) => ({ id: `msg_${id}`, role: "user", time: { created },
    source: { type: "editspace-mail", id, sender: "peer", recipient: "lane" } })
  const messages = [
    mail("a", 1_000),
    { id: "msg_human", role: "user", time: { created: 1_001 } },
    { id: "msg_turn", role: "assistant", parentID: "msg_human", time: { created: 1_100 } },
    mail("b", 2_000),
  ] as Message[]
  const rows = mailRows(messages, undefined)
  expect(rows.map((row) => row.message.id)).toEqual(["msg_a", "msg_human", "msg_turn", "msg_b"])
  expect(mailCauses(rows, new Map()).size).toBe(0)
})

test("a mail run without its source record reports no send time rather than inventing one", () => {
  const messages = [
    { id: "msg_m", role: "user", time: { created: 5_000 }, source: { type: "editspace-mail", id: "gone", sender: "peer", recipient: "lane" } },
    { id: "msg_t", role: "assistant", parentID: "msg_m", time: { created: 5_100 } },
  ] as Message[]
  expect(mailCauses(mailRows(messages, undefined), new Map()).get("msg_m")).toEqual({
    ids: ["gone"], kinds: [{ kind: "mail", human: false, catchUp: false, count: 1 }], senders: ["peer"], senderSessions: {}, promotedAt: 5_000 })
})

test("labels agent-originated resume and kickoff inputs by what the agent did", () => {
  expect(mailActivityLabel("resume")).toBe("Agent resume")
  expect(mailActivityLabel("spawn")).toBe("Agent kickoff")
  expect(mailActivityLabel("task")).toBe("Mail")
  expect(mailActivityLabel(undefined)).toBe("Mail")
})

test("keeps an agent resume in the session transcript although no mail record exists", () => {
  const source = { type: "editspace-mail", id: "es-resume-1", sender: "orchestrator", recipient: "work", kind: "resume" }
  const resume = { id: "msg_resume", sessionID: "ses_first", role: "user", time: { created: 3000 }, source } as unknown as Message
  const stale = { id: "msg_mail", sessionID: "ses_first", role: "user", time: { created: 3000 },
    source: { ...source, id: "gone", kind: "task" } } as unknown as Message
  expect(mailRows([resume, stale], undefined, [], { sessionID: "ses_first", from: 2000 }).map(row => row.message.id))
    .toEqual(["msg_resume"])
})

test("a mail cause keeps each sender's recorded session only when its records agree", () => {
  const mail = (id: string, created: number, sender: string) => ({ id: `msg_${id}`, role: "user", time: { created },
    source: { type: "editspace-mail", id, sender, recipient: "lane" } })
  const messages = [mail("a", 1_000, "orchestrator"), mail("b", 1_001, "squadron-v2"), mail("c", 1_002, "squadron-v2"),
    { id: "msg_t", role: "assistant", parentID: "msg_c", time: { created: 1_100 } }] as Message[]
  const record = (id: string, from: string, sender_session: string): MailMessage =>
    ({ id, ts: "", created_ms: 900, from, to: "lane", text: id, direction: "received", deliveries: [], sender_session })
  const records = new Map([record("a", "orchestrator", "ses_relay"), record("b", "squadron-v2", "ses_one"), record("c", "squadron-v2", "ses_two")]
    .map((item) => [item.id, item]))
  expect(mailCauses(mailRows(messages, undefined), records).get("msg_c")?.senderSessions).toEqual({ orchestrator: "ses_relay" })
})

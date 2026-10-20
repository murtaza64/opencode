import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import type { MailMessage, MailTimeline } from "./api"
import { mailForSession, mailLocation, mailRows, mailWake } from "./mail-timeline"

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
  expect(rows.map((row) => row.message.id)).toEqual(["msg_1", "msg_2", "mail_3", "msg_3"])
  expect(rows[1]).toMatchObject({ type: "transcript", timestamp: 2000 })
  expect(rows[2]).toMatchObject({ type: "mail", message: { direction: "received", deliveries: [{ recipient: "alpha", state: "read" }] } })
  expect(mailRows(messages, timeline, rows)[0]).toBe(rows[0])
  expect(mailRows(messages, timeline, rows)[1]).toBe(rows[1])
  expect(mailRows(messages, structuredClone(timeline), rows)[2]).toBe(rows[2])
  const updated = mailRows(messages, { ...timeline, messages: timeline.messages.map((message) => message.id === "mail_3"
    ? { ...message, deliveries: [{ ...message.deliveries[0], state: "handled" }] } : message) }, rows)
  expect(updated[2]).toMatchObject({ type: "mail", message: { deliveries: [{ state: "handled" }] } })
  expect(updated[2]).not.toBe(rows[2])
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

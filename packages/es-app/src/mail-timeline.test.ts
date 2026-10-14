import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import type { MailMessage, MailTimeline } from "./api"
import { mailForSession, mailLocation, mailRows } from "./mail-timeline"

test("selects the matching editspace and lane from the session directory", () => {
  const roots = [
    { name: "other", root: "/work" },
    { name: "correct", root: "/work/project/.editspace" },
  ]
  expect(mailLocation("/work/project/.editspace/lanes/alpha/repos/org/repo", roots)).toEqual({ name: "correct", lane: "alpha" })
  expect(mailLocation("/work/project/.editspace/lanes/alpha-extra", roots)).toEqual({ name: "correct", lane: "alpha-extra" })
  expect(mailLocation("/work/project/repos/org/repo", roots)).toBeUndefined()
  expect(mailLocation("/work/project", roots, "ses_parent")).toEqual({ name: "correct", session: "ses_parent" })
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
  const updated = mailRows(messages, { ...timeline, messages: timeline.messages.map((message) => message.id === "mail_3"
    ? { ...message, deliveries: [{ ...message.deliveries[0], state: "handled" }] } : message) }, rows)
  expect(updated[2]).toMatchObject({ type: "mail", message: { deliveries: [{ state: "handled" }] } })
  expect(updated[2]).not.toBe(rows[2])
})

test("scopes a shared lane feed to each session by receipt session, sender session, then ownership interval", () => {
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
  expect(old.map((message) => message.id)).toEqual(["old-received", "old-sent", "pending-before"])
  const next = mailForSession(messages, { sessionID: "ses_new", lane: "alpha", from: 2000 })
  expect(next.map((message) => message.id)).toEqual(["new-received", "new-sent", "late-presented"])
  expect(mailForSession(messages, { sessionID: "ses_new" }).map((message) => message.id))
    .toEqual(["pending-before", "new-received", "new-sent", "late-presented"])
})

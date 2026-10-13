import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import type { MailTimeline } from "./api"
import { mailLocation, mailRows } from "./mail-timeline"

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

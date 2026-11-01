import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { MailMessage } from "./api"
import { mailReceipts, mailSentText, type MailRecordsValue } from "./mail-receipts"

let next = 0
const shell = (command: string, output: string, status: "completed" | "error" | "running" = "completed") => ({
  id: `prt_mail_${++next}`, sessionID: "ses", messageID: "msg", type: "tool", callID: `call_${next}`, tool: "bash",
  state: status === "completed" ? { status, input: { command }, output, title: "", metadata: { exit: 0 }, time: { start: 0, end: 1 } }
    : status === "error" ? { status, input: { command }, error: output, metadata: {}, time: { start: 0, end: 1 } }
    : { status, input: { command }, title: "", metadata: {}, time: { start: 0 } },
}) as ToolPart
const record = (id: string, deliveries: { recipient: string; state: string; error?: string }[]) =>
  ({ id, deliveries: deliveries.map((delivery) => ({ message_id: id, session: null, mode: "actionable", request_id: null, presented_at: null, handled_at: null, error: null, ...delivery })) }) as unknown as MailMessage

// Records as a lane feed returns them (every recipient's receipts) unless `partial` names a session-feed record.
const records = (list: MailMessage[], partial: string[] = []): MailRecordsValue => {
  const byID = new Map(list.map((message) => [message.id, message]))
  return { record: (id) => byID.get(id), complete: (id) => byID.has(id) && !partial.includes(id), want: () => undefined }
}

describe("mail receipts", () => {
  test("every receipt line of an es mail call is read, in order", () => {
    const part = shell(`es mail send --to a --kind task "x" | head -1; es mail send --to b --kind notice "y"`,
      "sent a#12 (task) me -> a\nsent b#3 (notice) me -> b\n")
    expect(mailReceipts(part)).toEqual([{ id: "a#12", kind: "task", from: "me", to: "a" }, { id: "b#3", kind: "notice", from: "me", to: "b" }])
  })

  test("no receipt without the transport's line: a failed, running or non-mail call claims nothing", () => {
    expect(mailReceipts(shell(`es mail send --to a "x"`, "error: unknown lane", "error"))).toEqual([])
    expect(mailReceipts(shell(`es mail send --to a "x"`, "", "running"))).toEqual([])
    expect(mailReceipts(shell(`cat notes.txt`, "sent a#12 (task) me -> a"))).toEqual([])
  })

  test("without its record on this host a receipt stays reported sent, delivery not read", () => {
    const receipts = mailReceipts(shell(`es mail send --to a "x"`, "sent a#12 (task) me -> a"))
    expect(mailSentText(receipts, records([]))).toEqual({ text: "Mail reported sent to a", state: "delivery not read", detail: ["a#12 task to a: not found in this session's mail on its host"] })
  })

  test("a sent mail read from a session feed without recipient receipts is not 'no deliveries': delivery not read", () => {
    const receipts = mailReceipts(shell(`es mail send --to ux-feel "x"`, "sent ux-feel#423 (task) desktop-delivery -> ux-feel"))
    expect(mailSentText(receipts, records([record("ux-feel#423", [])], ["ux-feel#423"]))).toMatchObject({ text: "Mail sent to ux-feel", state: "delivery not read",
      detail: ["ux-feel#423 task to ux-feel: recipient receipts not read"] })
    // The sender lane's full feed: presented, then handled, each its own word.
    expect(mailSentText(receipts, records([record("ux-feel#423", [{ recipient: "ux-feel", state: "presented" }])])).state).toBe("presented")
    expect(mailSentText(receipts, records([record("ux-feel#423", [{ recipient: "ux-feel", state: "handled" }])])).state).toBe("handled")
    // A complete feed with no deliveries is a real "none".
    expect(mailSentText(receipts, records([record("ux-feel#423", [])])).state).toBe("no deliveries recorded")
  })

  test("the row shows the record's exact state; handled is acknowledgment, never started or completed", () => {
    const receipts = mailReceipts(shell(`es mail send --to a "x"`, "sent a#12 (task) me -> a"))
    for (const state of ["queued", "admitted", "presented", "handled"])
      expect(mailSentText(receipts, records([record("a#12", [{ recipient: "a", state }])]))).toMatchObject({ text: "Mail sent to a", state })
    const handled = mailSentText(receipts, records([record("a#12", [{ recipient: "a", state: "handled" }])]))
    expect(handled.detail).toEqual(["a#12 task to a: a handled (acknowledged by the recipient; not proof the work started)"])
    expect([handled.text, handled.state]).toEqual(["Mail sent to a", "handled"])
    expect(mailSentText(receipts, records([record("a#12", [{ recipient: "a", state: "queued", error: "no session" }])]))).toMatchObject({ state: "failed", detail: ["a#12 task to a: a failed (no session)"] })
  })

  test("several mails: recipients listed once; differing states read as mixed, any failure as failed", () => {
    const receipts = mailReceipts(shell(`es mail send --to a "x"; es mail send --to b "y"`, "sent a#1 (task) me -> a\nsent b#2 (notice) me -> b"))
    expect(mailSentText(receipts, records([record("a#1", [{ recipient: "a", state: "handled" }]), record("b#2", [{ recipient: "b", state: "queued" }])]))).toMatchObject({ text: "Mail sent to a, b", state: "mixed states" })
  })
})

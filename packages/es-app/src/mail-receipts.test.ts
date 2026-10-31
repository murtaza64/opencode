import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { MailMessage } from "./api"
import { mailReceipts, mailSentText } from "./mail-receipts"

let next = 0
const shell = (command: string, output: string, status: "completed" | "error" | "running" = "completed") => ({
  id: `prt_mail_${++next}`, sessionID: "ses", messageID: "msg", type: "tool", callID: `call_${next}`, tool: "bash",
  state: status === "completed" ? { status, input: { command }, output, title: "", metadata: { exit: 0 }, time: { start: 0, end: 1 } }
    : status === "error" ? { status, input: { command }, error: output, metadata: {}, time: { start: 0, end: 1 } }
    : { status, input: { command }, title: "", metadata: {}, time: { start: 0 } },
}) as ToolPart
const record = (id: string, deliveries: { recipient: string; state: string; error?: string }[]) =>
  ({ id, deliveries: deliveries.map((delivery) => ({ message_id: id, session: null, mode: "actionable", request_id: null, presented_at: null, handled_at: null, error: null, ...delivery })) }) as unknown as MailMessage

describe("mail receipts", () => {
  test("every receipt line of an es mail call is read, in order", () => {
    const part = shell(`es mail send --to a --kind task "x" | head -1; es mail send --to b --kind notice "y"`,
      "sent a#12 (task) me -> a\nsent b#3 (notice) me -> b\n")
    expect(mailReceipts(part)).toEqual([{ id: "a#12", kind: "task", to: "a" }, { id: "b#3", kind: "notice", to: "b" }])
  })

  test("no receipt without the transport's line: a failed, running or non-mail call claims nothing", () => {
    expect(mailReceipts(shell(`es mail send --to a "x"`, "error: unknown lane", "error"))).toEqual([])
    expect(mailReceipts(shell(`es mail send --to a "x"`, "", "running"))).toEqual([])
    expect(mailReceipts(shell(`cat notes.txt`, "sent a#12 (task) me -> a"))).toEqual([])
  })

  test("without its record on this host a receipt stays reported sent, delivery not read", () => {
    const receipts = mailReceipts(shell(`es mail send --to a "x"`, "sent a#12 (task) me -> a"))
    expect(mailSentText(receipts, () => undefined)).toEqual({ text: "Mail reported sent to a", state: "delivery not read", detail: ["a#12 task to a: delivery not read on this host"] })
  })

  test("the row shows the record's exact state; handled is acknowledgment, never started or completed", () => {
    const receipts = mailReceipts(shell(`es mail send --to a "x"`, "sent a#12 (task) me -> a"))
    for (const state of ["queued", "admitted", "presented", "handled"])
      expect(mailSentText(receipts, () => record("a#12", [{ recipient: "a", state }]))).toMatchObject({ text: "Mail sent to a", state })
    const handled = mailSentText(receipts, () => record("a#12", [{ recipient: "a", state: "handled" }]))
    expect(handled.detail).toEqual(["a#12 task to a: a handled (acknowledged by the recipient; not proof the work started)"])
    expect([handled.text, handled.state]).toEqual(["Mail sent to a", "handled"])
    expect(mailSentText(receipts, () => record("a#12", [{ recipient: "a", state: "queued", error: "no session" }]))).toMatchObject({ state: "failed", detail: ["a#12 task to a: a failed (no session)"] })
  })

  test("several mails: recipients listed once; differing states read as mixed, any failure as failed", () => {
    const receipts = mailReceipts(shell(`es mail send --to a "x"; es mail send --to b "y"`, "sent a#1 (task) me -> a\nsent b#2 (notice) me -> b"))
    const records = new Map([["a#1", record("a#1", [{ recipient: "a", state: "handled" }])], ["b#2", record("b#2", [{ recipient: "b", state: "queued" }])]])
    expect(mailSentText(receipts, (id) => records.get(id))).toMatchObject({ text: "Mail sent to a, b", state: "mixed states" })
  })
})

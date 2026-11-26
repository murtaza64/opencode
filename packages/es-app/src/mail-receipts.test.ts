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
const records = (list: MailMessage[], partial: string[] = [], unreadable?: string): MailRecordsValue => {
  const byID = new Map(list.map((message) => [message.id, message]))
  return { record: (id) => byID.get(id), complete: (id) => byID.has(id) && !partial.includes(id), want: () => undefined, unreadable: () => unreadable }
}
const send = (to: string, ...lines: string[]) => shell(`es mail send --to ${to} --kind task "x"`, lines.join("\n"))

// Real `es mail send` stdout shapes (dotfiles bin/es: narrate + _delivery_line).
const ADMITTED = ["sent setup#123 (task) orchestrator -> setup", "  setup: admitted (mail-setup#123-1); wake observed scheduled at 1793600000000 epoch_ms"]
const BUSY = ["sent desktop-delivery#666 (task) orchestrator -> desktop-delivery", "  desktop-delivery: admission (mail-dd#666-1): busy; admitted for its next turn; wake observed coalesced at 1793600000000 epoch_ms"]
const PENDING = ["sent android-ops#174 (task) orchestrator -> android-ops", "  android-ops: admission pending (mail-ao#174-1): busy; re-offered when idle (es mail watch, es mail delivery --retry)"]
const PASSIVE = ["sent serving-modes#127 (notice) orchestrator -> serving-modes", "  serving-modes: recorded only; recipient NOT woken (passive; read with es mail check)"]
const BRIDGE = ["sent rook#2745 (task) orchestrator -> rook", "  recorded only; recipient NOT woken (no runtime recipient: muted, filtered, or no owner)"]

describe("mail receipts", () => {
  test("every receipt of an es mail call is read with its send-time delivery lines", () => {
    expect(mailReceipts(shell(`es mail send --to setup "a"; es mail send --to serving-modes "b"`, [...ADMITTED, ...PASSIVE].join("\n")))).toEqual([
      { id: "setup#123", kind: "task", from: "orchestrator", to: "setup", atSend: [{ recipient: "setup", word: "admitted", line: ADMITTED[1]!.trim().slice(7) }] },
      { id: "serving-modes#127", kind: "notice", from: "orchestrator", to: "serving-modes", atSend: [{ recipient: "serving-modes", word: "recorded only, not woken", line: PASSIVE[1]!.trim().slice(15) }] },
    ])
  })

  test("no receipt without the transport's line: a failed, running or non-mail call claims nothing", () => {
    expect(mailReceipts(shell(`es mail send --to a "x"`, "error: unknown lane", "error"))).toEqual([])
    expect(mailReceipts(shell(`es mail send --to a "x"`, "", "running"))).toEqual([])
    expect(mailReceipts(shell(`cat notes.txt`, ADMITTED.join("\n")))).toEqual([])
  })

  test("current receipts win: presented and handled are their own words, handled never 'started'", () => {
    const receipts = mailReceipts(send("setup", ...ADMITTED))
    expect(mailSentText(receipts, records([record("setup#123", [{ recipient: "setup", state: "presented" }])]))).toMatchObject({ text: "Mail sent to setup", state: "presented" })
    const handled = mailSentText(receipts, records([record("setup#123", [{ recipient: "setup", state: "handled" }])]))
    expect(handled).toMatchObject({ text: "Mail sent to setup", state: "handled", detail: ["setup#123 task to setup: setup handled (acknowledged by the recipient; not proof the work started)"] })
    expect(handled.tick).toMatchObject({ tick: "read", level: "presented", label: "Read by setup" })
  })

  test("the tick: current receipts, else the send-time lines (said so), else a lost receipt (never the inbox)", () => {
    const receipts = mailReceipts(send("setup", ...ADMITTED))
    expect(mailSentText(receipts, records([record("setup#123", [{ recipient: "setup", state: "admitted" }])])).tick)
      .toMatchObject({ tick: "delivered", level: "inbox", label: "In setup's inbox" })
    expect(mailSentText(receipts, records([])).tick).toMatchObject({ tick: "delivered", level: "inbox", label: "In setup's inbox (at send)" })
    const bare = mailReceipts(send("ux-feel", "sent ux-feel#423 (task) composer -> ux-feel"))
    expect(mailSentText(bare, records([])).tick).toMatchObject({ tick: "sent", level: "sending", label: "Sent · delivery receipt not available (not loaded here)" })
    expect(mailSentText(bare, records([record("ux-feel#423", [])])).tick.label).toBe("Sent · delivery receipt not available (no runtime delivery recorded)")
  })

  test("without current receipts the send-time state shows, marked 'at send', never 'not read'", () => {
    expect(mailSentText(mailReceipts(send("setup", ...ADMITTED)), records([]))).toMatchObject({ text: "Mail sent to setup", state: "admitted at send" })
    expect(mailSentText(mailReceipts(send("desktop-delivery", ...BUSY)), records([]))).toMatchObject({ state: "admitted at send" })
    expect(mailSentText(mailReceipts(send("android-ops", ...PENDING)), records([]))).toMatchObject({ state: "admission pending at send" })
    // A refused read on another host is named in the card.
    expect(mailSentText(mailReceipts(send("setup", ...ADMITTED)), records([], [], "mini's mail not readable from this window (HTTP 403)")).detail[0])
      .toBe("setup#123 task to setup: setup: admitted (mail-setup#123-1); wake observed scheduled at 1793600000000 epoch_ms (as printed at send; mini's mail not readable from this window (HTTP 403))")
  })

  test("passive and bridge-addressed mail say they were recorded without waking anyone", () => {
    expect(mailSentText(mailReceipts(send("serving-modes", ...PASSIVE)), records([record("serving-modes#127", [])]))).toMatchObject({ state: "recorded only, not woken" })
    expect(mailSentText(mailReceipts(send("rook", ...BRIDGE)), records([record("rook#2745", [])]))).toMatchObject({ state: "recorded only, no runtime recipient" })
  })

  test("no evidence at all says the state was not loaded; a session feed without receipts is not 'none'", () => {
    const bare = mailReceipts(send("ux-feel", "sent ux-feel#423 (task) desktop-delivery -> ux-feel"))
    expect(mailSentText(bare, records([]))).toMatchObject({ text: "Mail sent to ux-feel", state: "delivery state not loaded" })
    expect(mailSentText(bare, records([record("ux-feel#423", [])], ["ux-feel#423"]))).toMatchObject({ state: "delivery state not loaded", detail: ["ux-feel#423 task to ux-feel: recipient receipts not loaded here"] })
    expect(mailSentText(bare, records([record("ux-feel#423", [])])).state).toBe("no deliveries recorded")
  })

  test("several mails: recipients listed once; differing states read as mixed, any failure as failed", () => {
    const receipts = mailReceipts(shell(`es mail send --to a "x"; es mail send --to b "y"`, "sent a#1 (task) me -> a\nsent b#2 (notice) me -> b"))
    expect(mailSentText(receipts, records([record("a#1", [{ recipient: "a", state: "handled" }]), record("b#2", [{ recipient: "b", state: "queued" }])]))).toMatchObject({ text: "Mail sent to a, b", state: "mixed states" })
    expect(mailSentText(receipts, records([record("a#1", [{ recipient: "a", state: "queued", error: "no session" }]), record("b#2", [{ recipient: "b", state: "queued" }])])).state).toBe("failed")
  })
})

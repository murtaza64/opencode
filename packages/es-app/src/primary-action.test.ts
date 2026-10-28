import { expect, test } from "bun:test"
import type { InputReceipt } from "./composer"
import { primaryAction } from "./primary-action"

const receipt = (requestID: string, delivery: "steer" | "queue", admittedSeq: number, extra: Record<string, unknown> = {}) =>
  ({ requestID, delivery, text: requestID, agent: "build", sessionID: "ses_1", admittedSeq, timeCreated: admittedSeq, state: "pending", ...extra }) as InputReceipt
const base = { hasContent: false, busy: true, keyboardTarget: "steer" as const, receipts: [] as InputReceipt[], interrupt: true, delivering: null, unsettled: false, nudging: false, nudge: true }

test("a draft with content keeps Send while idle and the keyboard target while busy", () => {
  expect(primaryAction({ ...base, hasContent: true, busy: false })).toMatchObject({ kind: "send", action: "steer", label: "Send" })
  expect(primaryAction({ ...base, hasContent: true, keyboardTarget: "queue", receipts: [receipt("in_1", "steer", 1)] }))
    .toMatchObject({ kind: "send", action: "queue", label: "Queue" })
})

test("an empty draft with a confirmed pending steer interrupts and delivers the oldest one", () => {
  const result = primaryAction({ ...base, receipts: [receipt("in_2", "steer", 5), receipt("in_1", "steer", 3)] })
  expect(result).toMatchObject({ kind: "deliver", requestID: "in_1", label: "Interrupt & steer now" })
  expect(result.disabled).toBeUndefined()
  expect(primaryAction({ ...base, busy: false, receipts: [receipt("in_1", "steer", 3)] }).label).toBe("Steer now")
})

test("agent mail, settled inputs and queued inputs are not delivered as the human's steer", () => {
  const mail = receipt("mail_1", "steer", 1, { source: { type: "editspace-mail", id: "m", sender: "x", recipient: "y" } })
  const promoted = receipt("in_9", "steer", 2, { state: "promoted", messageID: "msg_1", timePromoted: 3 })
  expect(primaryAction({ ...base, receipts: [mail, promoted] })).toMatchObject({ kind: "nudge", label: "Nudge" })
  const queued = primaryAction({ ...base, receipts: [receipt("in_3", "queue", 4)] })
  expect(queued).toMatchObject({ kind: "nudge" })
  expect(queued.disabled).toContain("queued input")
})

test("an empty draft with nothing pending nudges; never while a send outcome is unknown or a nudge runs", () => {
  expect(primaryAction(base)).toMatchObject({ kind: "nudge", label: "Nudge" })
  expect(primaryAction({ ...base, unsettled: true }).disabled).toContain("not confirmed")
  expect(primaryAction({ ...base, nudging: true })).toMatchObject({ label: "Nudging…" })
  expect(primaryAction({ ...base, nudging: true }).disabled).toBeTruthy()
})

test("without Core's explicit continuation an empty Nudge is unavailable, not a no-op", () => {
  const result = primaryAction({ ...base, nudge: false })
  expect(result).toMatchObject({ kind: "nudge", label: "Nudge" })
  expect(result.disabled).toContain("not available")
  expect(primaryAction({ ...base, nudge: false, receipts: [receipt("in_1", "steer", 1)] })).toMatchObject({ kind: "deliver", requestID: "in_1" })
})

test("without the interrupt capability a pending steer is explained, not delivered; an in-flight delivery disables", () => {
  expect(primaryAction({ ...base, interrupt: false, receipts: [receipt("in_1", "steer", 1)] }).disabled).toContain("cannot deliver")
  expect(primaryAction({ ...base, delivering: "in_1", receipts: [receipt("in_1", "steer", 1)] })).toMatchObject({ label: "Steering…", disabled: expect.any(String) })
})

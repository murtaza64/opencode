import { expect, test } from "bun:test"
import { bubbleTick, laterTick, mailTick, transcriptTick } from "./message-ticks"

test("an outgoing bubble is sending, then sent with how it waits, or not sent", () => {
  expect(bubbleTick({ status: "sending" }).tick).toBe("sending")
  expect(bubbleTick({ status: "pending", delivery: "steer" })).toMatchObject({ tick: "sent", label: expect.stringContaining("steer, not yet delivered") })
  expect(bubbleTick({ status: "pending", delivery: "queue" }).label).toContain("queued, not yet delivered")
  expect(bubbleTick({ status: "unknown" })).toEqual({ tick: "failed", label: "Not confirmed" })
  expect(bubbleTick({ status: "absent" })).toEqual({ tick: "failed", label: "Not sent" })
})

test("read needs a turn start after the promotion; a turn that started before it (a steer) leaves it delivered", () => {
  expect(transcriptTick({ promotedAt: 1000 }).tick).toBe("delivered")
  expect(transcriptTick({ promotedAt: 1000, turnStarted: 900 }).tick).toBe("delivered")
  expect(transcriptTick({ promotedAt: 1000, turnStarted: 1000 }).tick).toBe("delivered")
  expect(transcriptTick({ promotedAt: 1000, turnStarted: 1001 }).tick).toBe("read")
})

test("states never step back; a failure only replaces a message still on this device", () => {
  expect(laterTick("delivered", "sent")).toBe("delivered")
  expect(laterTick("read", "delivered")).toBe("read")
  expect(laterTick("sent", "failed")).toBe("sent")
  expect(laterTick("sending", "failed")).toBe("failed")
  expect(laterTick("failed", "sent")).toBe("sent")
  expect(["sending", "sent", "delivered", "read"].reduce<ReturnType<typeof laterTick> | undefined>((a, b) => laterTick(a, b as never), undefined)).toBe("read")
})

test("mail: stored or admitted is sent, presented or handled is delivered (never read), passive says not woken", () => {
  expect(mailTick("admitted at send").tick).toBe("sent")
  expect(mailTick("presented").tick).toBe("delivered")
  expect(mailTick("handled")).toEqual({ tick: "delivered", label: "Mail delivered and acknowledged; not proof the work started" })
  expect(mailTick("recorded only, not woken")).toEqual({ tick: "sent", label: "Mail recorded, recipient not woken" })
  expect(mailTick("failed").tick).toBe("failed")
  expect(["admitted", "queued", "presented", "handled", "delivery state not loaded"].map((state) => mailTick(state).tick)).not.toContain("read")
})

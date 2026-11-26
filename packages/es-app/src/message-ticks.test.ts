import { expect, test } from "bun:test"
import { bubbleTick, laterTick, transcriptTick } from "./message-ticks"

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

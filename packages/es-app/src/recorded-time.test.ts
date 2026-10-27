import { expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { blockTime, recordedTime } from "./recorded-time"

const full = (at: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(at)
const message = { id: "msg_1", sessionID: "ses_a", role: "user", time: { created: 1_700_000_000_000 } } as Message

test("formats a recorded time with full date, time and zone", () => {
  expect(recordedTime(1_700_000_000_000)).toBe(full(1_700_000_000_000))
  expect(recordedTime(undefined)).toBeUndefined()
  expect(recordedTime(Number.NaN)).toBeUndefined()
})

test("an agent text block uses its own start time, else the message's creation", () => {
  const part = { id: "prt_1", messageID: "msg_1", sessionID: "ses_a", type: "text", text: "hi", time: { start: 1_700_000_060_000 } } as Part
  expect(blockTime(message, part)).toBe(full(1_700_000_060_000))
  expect(blockTime(message, { ...part, time: undefined } as Part)).toBe(full(1_700_000_000_000))
  expect(blockTime(message)).toBe(full(1_700_000_000_000))
})

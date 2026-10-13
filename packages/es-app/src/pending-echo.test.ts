import { expect, test } from "bun:test"
import { pendingEcho } from "./pending-echo"

test("no submission has no echo", () => {
  expect(pendingEcho(null, [])).toBe(false)
})

test("submission without a matching later user message has an echo", () => {
  expect(pendingEcho({ text: "hello", status: "sending", after: "msg_1" }, [
    { id: "msg_2", role: "assistant", text: "hello" },
    { id: "msg_3", role: "user", text: "other" },
  ])).toBe(true)
})

test("matching later user message clears the echo", () => {
  expect(pendingEcho({ text: "hello", status: "accepted", after: "msg_1" }, [
    { id: "msg_2", role: "user", text: "hello" },
  ])).toBe(false)
})

test("identical text before the submission does not clear the echo", () => {
  expect(pendingEcho({ text: "hello", status: "sending", after: "msg_2" }, [
    { id: "msg_2", role: "user", text: "hello" },
  ])).toBe(true)
})

test("unknown outcome still has an echo", () => {
  expect(pendingEcho({ text: "hello", status: "unknown" }, [])).toBe(true)
})

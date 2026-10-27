import { expect, test } from "bun:test"
import { coalesced } from "./coalesced"

test("a burst of events runs once at once and once trailing, then idles", async () => {
  let runs = 0
  const call = coalesced(() => runs++, 50)
  for (let index = 0; index < 100; index++) call()
  expect(runs).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runs).toBe(2)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runs).toBe(2)
})

test("continuous events are capped at one run per interval", async () => {
  let runs = 0
  const call = coalesced(() => runs++, 50)
  const timer = setInterval(call, 2)
  await new Promise((resolve) => setTimeout(resolve, 520))
  clearInterval(timer)
  call.cancel()
  expect(runs).toBeGreaterThanOrEqual(9)
  expect(runs).toBeLessThanOrEqual(12)
})

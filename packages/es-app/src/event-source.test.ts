import { afterEach, expect, test } from "bun:test"
import { createEventHub } from "./event-source"

const previous = Object.getOwnPropertyDescriptor(globalThis, "EventSource")
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "EventSource", previous)
  else Reflect.deleteProperty(globalThis, "EventSource")
})

test("uses native event streams when the protected origin has no mux capability", async () => {
  const opened: string[] = []
  const closed: string[] = []
  class Native {
    onopen = null
    onerror = null
    onmessage = null
    constructor(readonly url: string) { opened.push(url) }
    close() { closed.push(this.url) }
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Native })
  const hub = createEventHub(() => { throw new Error("Unavailable socket should not be attempted") }, Promise.resolve(false))
  const source = hub.subscribe("/oc/event?directory=%2Ffixture")
  await Promise.resolve()
  expect(opened).toEqual(["/oc/event?directory=%2Ffixture"])
  hub.pause()
  expect(closed).toEqual(opened)
  hub.resume()
  expect(opened).toHaveLength(2)
  source.close()
  expect(closed).toEqual(opened)
  hub.close()
})

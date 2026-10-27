import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test"
import { oc } from "./api"

let fetchSpy: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
let calls: { url: string; signal?: AbortSignal | null }[]
let release: () => void
beforeEach(() => {
  calls = []
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  release = open
  fetchSpy = spyOn(globalThis, "fetch")
  fetchSpy.mockImplementation(async (input, init) => {
    calls.push({ url: String(input), signal: init?.signal })
    await gate
    const items = Array.from({ length: 80 }, (_, index) => ({ info: { id: `msg_${String(index).padStart(3, "0")}` }, parts: [] }))
    return Response.json(items, { headers: { "X-Next-Cursor": "msg_000" } })
  })
})
afterEach(() => fetchSpy.mockRestore())

test("concurrent reads of one session tail share a single request; each caller gets its own copy", async () => {
  const page = oc.messagesPage("ses_a", "/repo", 80)
  const tail = oc.messagesTail("ses_a", "/repo", 20)
  const again = oc.messagesPage("ses_a", "/repo", 80)
  release()
  const [a, b, c] = await Promise.all([page, tail, again])
  expect(calls).toHaveLength(1)
  expect(a.items).toHaveLength(80)
  expect(a.cursor).toBe("msg_000")
  expect(b.map((message) => message.info.id)).toEqual(a.items.slice(-20).map((message) => message.info.id))
  expect(c.items[0]).not.toBe(a.items[0])
})

test("one caller cancelling does not cancel the read for the others; all cancelling does", async () => {
  const first = new AbortController()
  const kept = oc.messagesPage("ses_b", "/repo", 80, undefined, first.signal).catch((error) => error)
  const other = oc.messagesPage("ses_b", "/repo", 80)
  first.abort()
  expect(calls[0]!.signal!.aborted).toBe(false)
  release()
  expect((await other).items).toHaveLength(80)
  expect(await kept).toBeInstanceOf(DOMException)
  const solo = new AbortController()
  const alone = oc.messagesPage("ses_c", "/repo", 80, undefined, solo.signal).catch(() => "aborted")
  solo.abort()
  expect(await alone).toBe("aborted")
  expect(calls.at(-1)!.signal!.aborted).toBe(true)
})

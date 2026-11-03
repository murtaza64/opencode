import { afterEach, expect, spyOn, test } from "bun:test"
import { surfaceOwner } from "./surface-owner"

const state = (lanes: { lane: string; owner?: string }[], sessions: { id: string; directory?: string }[]) => ({ threads: [{ lanes }], sessions })
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
const answer = (body: unknown, status = 200) => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(body, { status })) as unknown as typeof fetch)
}
afterEach(() => fetchSpy?.mockRestore())

test("the owner is the lane record's current owner session on that host (a handoff already moved it)", async () => {
  answer(state([{ lane: "granola", owner: "ses_successor" }], [{ id: "ses_old", directory: "/r" }, { id: "ses_successor", directory: "/r/lanes/granola" }]))
  expect(await surfaceOwner({ lane: "granola", editspace: "opencode" }, "/hosts/mini")).toEqual({ state: "ok", session: "ses_successor", directory: "/r/lanes/granola" })
  expect(String(fetchSpy.mock.calls[0]![0])).toBe("/hosts/mini/es/api/state?es=opencode")
})

test("no lane, no lane record, no current owner session, or an unreadable host: never a guessed session", async () => {
  expect(await surfaceOwner({ lane: null, editspace: "opencode" }, "")).toMatchObject({ state: "none" })
  answer(state([], []))
  expect(await surfaceOwner({ lane: "granola", editspace: "opencode" }, "")).toMatchObject({ state: "none" })
  fetchSpy.mockRestore()
  answer(state([{ lane: "granola", owner: "ses_gone" }], []))
  expect(await surfaceOwner({ lane: "granola", editspace: "opencode" }, "")).toMatchObject({ state: "none", why: "no current owner session" })
  fetchSpy.mockRestore()
  answer(state([{ lane: "granola", owner: "ses_a" }, { lane: "granola", owner: "ses_b" }], [{ id: "ses_a", directory: "/a" }, { id: "ses_b", directory: "/b" }]))
  expect(await surfaceOwner({ lane: "granola", editspace: "opencode" }, "")).toMatchObject({ state: "unknown", why: "owner ambiguous" })
  fetchSpy.mockRestore()
  answer({ error: "down" }, 503)
  expect(await surfaceOwner({ lane: "granola", editspace: "opencode" }, "")).toMatchObject({ state: "unknown" })
})

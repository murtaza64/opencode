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
  expect(await surfaceOwner({ lane: "granola", editspace: "opencode" }, "/hosts/mini")).toEqual({ state: "ok", session: "ses_successor", directory: "/r/lanes/granola", busy: false })
  expect(String(fetchSpy.mock.calls[0]![0])).toBe("/hosts/mini/es/api/state?es=opencode")
})

test("no lane, no lane record, no current owner session, or an unreadable host: never a guessed session", async () => {
  expect(await surfaceOwner({ lane: null, editspace: "opencode" }, "")).toMatchObject({ state: "none" })
  // A lane that no card shows on this read is unknown, never "not found".
  answer(state([], []))
  expect(await surfaceOwner({ lane: "granola", editspace: "opencode" }, "")).toMatchObject({ state: "unknown", why: "owner of granola not listed on that host now" })
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

test("the live dashboard shape: lanes and sessions on each card, no top-level lanes", async () => {
  // Shape of a real es-dashboard /api/state (project-directions on the Mini), values shortened.
  answer({
    editspace: "project-directions",
    threads: [
      { kind: "session", key: "ses_ee8cfixture", title: "EKS lead", tickets: [], prs: [],
        lanes: [{ lane: "eks-lead", owner: "ses_ee8cfixture", status: "active", dir: "/es/project-directions/lanes/eks-lead", activity: "", issue: "" }],
        sessions: [{ id: "ses_ee8cfixture", title: "EKS lead", live: "idle", directory: "/es/project-directions/lanes/eks-lead/repos/x" }] },
      { kind: "ticket", key: "T-1", lanes: [], sessions: [] },
    ],
    sessions: [{ id: "ses_other", title: "other", live: "idle", directory: "/es/project-directions" }],
  })
  expect(await surfaceOwner({ lane: "eks-lead", editspace: "project-directions" }, "/hosts/mini")).toEqual({ state: "ok", session: "ses_ee8cfixture", directory: "/es/project-directions/lanes/eks-lead/repos/x", busy: false })
})

test("a busy owner session is reported busy, for the author chip's activity dot", async () => {
  answer({ threads: [{ lanes: [{ lane: "ux-feel", owner: "ses_busy" }], sessions: [{ id: "ses_busy", directory: "/r/ux-feel", live: "busy" }] }] })
  expect(await surfaceOwner({ lane: "ux-feel", editspace: "opencode" }, "")).toEqual({ state: "ok", session: "ses_busy", directory: "/r/ux-feel", busy: true })
})

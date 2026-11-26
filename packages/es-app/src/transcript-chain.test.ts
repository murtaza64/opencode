import { expect, test } from "bun:test"
import { deskChain, handoffPlumbing, laneChain, successionPredecessor } from "./transcript-chain"

const edge = (predecessor: string, successor: string, lane = "work", reason?: string) => ({ lane, predecessor, successor, ...(reason ? { reason } : {}) })

test("a lane chain follows verified edges back three hops, nearest first", () => {
  const chain = laneChain("ses_c", [edge("ses_a", "ses_b"), edge("ses_b", "ses_c", "work", "context full"), edge("ses_x", "ses_y")])
  expect(chain).toEqual({ links: [{ session: "ses_b", reason: "context full" }, { session: "ses_a" }] })
})

test("two edges into one session stop the chain with a note, keeping the verified part", () => {
  expect(laneChain("ses_c", [edge("ses_b", "ses_c"), edge("ses_a", "ses_b"), edge("ses_z", "ses_b")]))
    .toEqual({ links: [{ session: "ses_b" }], broken: "ambiguous" })
})

test("a change of lane or a cycle stops the chain", () => {
  expect(laneChain("ses_c", [edge("ses_b", "ses_c"), edge("ses_a", "ses_b", "other")]).broken).toBe("ambiguous")
  expect(laneChain("ses_c", [edge("ses_b", "ses_c"), edge("ses_c", "ses_b")])).toEqual({ links: [{ session: "ses_b" }], broken: "cycle" })
})

test("a session without a predecessor has an empty, unbroken chain", () => {
  expect(laneChain("ses_a", [edge("ses_a", "ses_b")])).toEqual({ links: [] })
})

test("the desk chain takes the pointer's predecessors and checks each successor's own succession record", () => {
  const earlier = [{ session: "ses_d2", directory: "/d", until: 2 }, { session: "ses_d1", directory: "/d", until: 1 }, { session: "ses_d0", directory: "/d", until: 0 }]
  const records: Record<string, string> = { ses_d3: "ses_d2", ses_d2: "ses_d1" }
  // ses_d1 (an older desk) has no record: the pointer alone links it to ses_d0.
  expect(deskChain("ses_d3", earlier, (id) => records[id]).links.map((link) => link.session)).toEqual(["ses_d2", "ses_d1", "ses_d0"])
  const wrong = deskChain("ses_d3", earlier, (id) => ({ ses_d3: "ses_d2", ses_d2: "ses_other" })[id])
  expect(wrong).toEqual({ links: [earlier[0]], broken: "mismatch" })
  expect(deskChain("ses_d3", [earlier[0]!, { session: "ses_d3", directory: "/d" }], () => undefined).broken).toBe("cycle")
})

test("succession metadata and handoff plumbing are recognized only from their records", () => {
  expect(successionPredecessor({ frontDesk: { succession: { key: "k", predecessor: "ses_abc" } } })).toBe("ses_abc")
  expect(successionPredecessor({ frontDesk: { succession: { predecessor: "not a session" } } })).toBeUndefined()
  expect(successionPredecessor(undefined)).toBeUndefined()
  expect(handoffPlumbing([{ type: "text", metadata: { source: "front-desk/succession-brief-request" } }])).toBe(true)
  expect(handoffPlumbing([{ type: "text", metadata: { source: "front-desk/succession" } }])).toBe(true)
  expect(handoffPlumbing([{ type: "text" }])).toBe(false)
  expect(handoffPlumbing([])).toBe(false)
})

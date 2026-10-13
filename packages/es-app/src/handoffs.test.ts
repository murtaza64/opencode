import { describe, expect, test } from "bun:test"
import { handoffChain, handoffNext, successorFor, transferPins } from "./handoffs"

describe("handoff lineage", () => {
  const edges = [
    { lane: "work", predecessor: "ses_old", successor: "ses_new" },
    { lane: "work", predecessor: "ses_older", successor: "ses_old" },
  ]
  test("only follows the explicit edge when its successor owns the lane", () => {
    expect(successorFor("ses_old", edges, [{ lane: "work", owner: "ses_new" }])).toEqual(edges[0])
    expect(successorFor("ses_old", edges, [{ lane: "work", owner: "ses_other" }])).toBeUndefined()
    expect(successorFor("ses_old", edges, [])).toBeUndefined()
    expect(successorFor("ses_old", [...edges, { lane: "another", predecessor: "ses_old", successor: "ses_other" }],
      [{ lane: "work", owner: "ses_new" }])).toBeUndefined()
  })
  test("follows a chain to the current owner without reviving an intermediate writer", () => {
    expect(successorFor("ses_older", edges, [{ lane: "work", owner: "ses_new" }])).toEqual({
      lane: "work", predecessor: "ses_older", successor: "ses_new",
    })
  })
  test("predecessors remain independently addressable", () => {
    expect(handoffChain("ses_old", edges)).toEqual(edges[1])
    expect(handoffChain("ses_new", edges)).toEqual(edges[0])
    expect(handoffChain("ses_older", edges)).toBeUndefined()
    expect(handoffNext("ses_older", edges)).toEqual(edges[1])
    expect(handoffNext("ses_old", edges)).toEqual(edges[0])
  })
  test("moves only the predecessor pin, retaining position and other projects", () => {
    expect(transferPins(['["/a","ses_old"]', '["/b","ses_old"]', '["/a","ses_new"]'], "ses_old", "ses_new", "/a"))
      .toEqual(['["/a","ses_new"]', '["/b","ses_old"]'])
  })
})

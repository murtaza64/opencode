import { describe, expect, test } from "bun:test"
import { handoffChain, handoffNext, successorFor, transferPins, reconcilePins, reconcileHostPins } from "./handoffs"

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
  test("reconciles unviewed pins through multiple hops with verified directory identities", () => {
    const rows = ["ses_older", "ses_old", "ses_new"].map((id) => ({ id, directory: "/a" }))
    expect(reconcilePins(['["/a","ses_older"]', '["/b","ses_old"]'], edges,
      [{ lane: "work", owner: "ses_new" }], rows)).toEqual(['["/a","ses_new"]'])
    expect(reconcilePins(['["/a","ses_old"]'], edges, [{ lane: "work", owner: "ses_new" }],
      [{ id: "ses_old", directory: "/a" }, { id: "ses_new", directory: "/b" }])).toEqual(['["/b","ses_new"]'])
  })
  test("missing, cyclic or ambiguous lineage never rewrites a pin", () => {
    const rows = ["ses_old", "ses_new"].map((id) => ({ id, directory: "/a" }))
    const pins = ['["/a","ses_old"]']
    expect(reconcilePins(pins, edges, [], rows)).toEqual(pins)
    expect(reconcilePins(pins, edges, [{ lane: "work", owner: "ses_new" }], [])).toEqual(pins)
    expect(successorFor("ses_old", edges, [{ lane: "work", owner: "ses_new" }, { lane: "work", owner: "ses_other" }])).toBeUndefined()
    expect(successorFor("ses_old", [...edges, { lane: "work", predecessor: "ses_new", successor: "ses_old" }], [{ lane: "work", owner: "ses_old" }])).toBeUndefined()
  })
})

describe("Work host pins", () => {
  const pin = '["/mini","P"]'
  const rows = [{ host: "mini", id: "P", directory: "/mini" }, { host: "mini", id: "S", directory: "/mini" }]
  const edge = { lane: "orchestrator", predecessor: "P", successor: "S" }
  // One editspace holding every directory, as a single-project read gives.
  const one = (lineage: { edges: typeof edge[]; owners: { lane: string; owner: string }[] }) => ({ byEditspace: { fixture: lineage }, editspaceOf: () => "fixture" })
  test("follows a verified handoff using only that host's rows", () => {
    expect(reconcileHostPins("mini", [pin], one({ edges: [edge], owners: [{ lane: "orchestrator", owner: "S" }] }), rows))
      .toEqual(['["/mini","S"]'])
    expect(reconcileHostPins("mini", [pin], one({ edges: [edge], owners: [{ lane: "orchestrator", owner: "S" }] }),
      [{ host: "mini", id: "P", directory: "/mini" }, { host: "local", id: "S", directory: "/mini" }])).toEqual([pin])
  })
  test("retains the pin if the owner is not the tip", () => {
    expect(reconcileHostPins("mini", [pin], one({ edges: [edge], owners: [{ lane: "orchestrator", owner: "P" }] }), rows)).toEqual([pin])
  })
  test("retains the pin if the successor is absent or appears twice", () => {
    const lineage = { edges: [edge], owners: [{ lane: "orchestrator", owner: "S" }] }
    expect(reconcileHostPins("mini", [pin], one(lineage), rows.slice(0, 1))).toEqual([pin])
    expect(reconcileHostPins("mini", [pin], one(lineage), [...rows, rows[1]!])).toEqual([pin])
  })
  test("retains the pin if the predecessor has two outgoing edges or the read failed", () => {
    expect(reconcileHostPins("mini", [pin], one({ edges: [edge, { ...edge, successor: "T" }], owners: [{ lane: "orchestrator", owner: "S" }] }), rows)).toEqual([pin])
    expect(reconcileHostPins("mini", [pin], undefined, rows)).toEqual([pin])
  })
  test("each pin follows only the lineage of the editspace holding its directory", () => {
    // Another editspace reuses the lane name; its pin (Q) has no lineage read and stays.
    const other = '["/other","Q"]'
    const lineage = { byEditspace: { mini: { edges: [edge, { lane: "orchestrator", predecessor: "Q", successor: "R" }], owners: [{ lane: "orchestrator", owner: "S" }] } },
      editspaceOf: (directory: string) => directory === "/mini" ? "mini" : directory === "/other" ? "other" : undefined }
    expect(reconcileHostPins("mini", [pin, other], lineage, [...rows, { host: "mini", id: "Q", directory: "/other" }, { host: "mini", id: "R", directory: "/other" }])).toEqual(['["/mini","S"]', other])
  })
})

import { expect, test } from "bun:test"
import { deliverables, type Surface } from "./surfaces"

const surface = (id: string, extra: Partial<Surface>): Surface => ({
  id, title: id, summary: null, kind: "path", owner: "Relay", lane: "orchestrator", editspace: "opencode",
  updated_at: 1, revision: 1, health: { state: "ok" }, ...extra,
})

test("new deliverables lead newest first; opened ones and boards stay out of the new list", () => {
  const list = [
    surface("board", { purpose: "board" }),
    surface("old-report", { purpose: "deliverable", created_at: 10, seen: false }),
    surface("week-review", { purpose: "deliverable", created_at: 30, seen: false }),
    surface("read-report", { purpose: "deliverable", created_at: 20, seen: true }),
  ]
  const split = deliverables(list, new Set())
  expect(split.fresh.map(item => item.id)).toEqual(["week-review", "old-report"])
  expect(split.earlier.map(item => item.id)).toEqual(["read-report"])
})

test("a deliverable opened on this page is no longer new even before the dashboard confirms, but a republish is", () => {
  const opened = new Set(["week-review:1"])
  expect(deliverables([surface("week-review", { purpose: "deliverable", seen: false })], opened).fresh).toEqual([])
  expect(deliverables([surface("week-review", { purpose: "deliverable", seen: false, revision: 2 })], opened).fresh.map(item => item.id)).toEqual(["week-review"])
})

test("surfaces from a dashboard without purposes are boards", () => {
  expect(deliverables([surface("relay-board", {})], new Set())).toEqual({ fresh: [], earlier: [] })
})

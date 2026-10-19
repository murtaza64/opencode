import { expect, test } from "bun:test"
import { cloudHref, cloudKey, cloudOwnerKnown, decodeCloudPins } from "./cloud-agents"

test("cloud pins preserve exact workflow owner identity across reused lane names", () => {
  expect(cloudKey({ editspace: "fixture", lane: "review", owner: "wingman:first" })).not.toBe(cloudKey({ editspace: "fixture", lane: "review", owner: "wingman:replacement" }))
})

test("cloud links use an encoded cloud route, never a local Session ID route", () => {
  expect(cloudHref({ editspace: "project & two", lane: "review", owner: "wingman:task?x#y" })).toBe("/cloud?es=project%20%26%20two&lane=review&owner=wingman%3Atask%3Fx%23y")
})

test("legacy lane-only pins stay unbound until an observed owner is available", () => {
  expect(decodeCloudPins(JSON.stringify([JSON.stringify(["wingman", "fixture", "review"])]))).toEqual([{ editspace: "fixture", lane: "review", owner: "" }])
})

test("a pending cloud owner is not a stable workflow identity", () => {
  expect(cloudOwnerKnown("wingman:pending")).toBe(false)
  expect(cloudOwnerKnown("wingman:es-fixture-review-1-task")).toBe(true)
})

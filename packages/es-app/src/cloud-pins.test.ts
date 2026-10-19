import { describe, expect, test } from "bun:test"
import { cloudPinKey, parseCloudPin, readCloudPins, toggledCloudPins } from "./cloud-pins"

const pin = { runtime: "wingman" as const, editspace: "workbench-upgrade", lane: "svc-wb" }

describe("cloud pins", () => {
  test("a cloud pin key round-trips to the same editspace and lane", () => {
    expect(parseCloudPin(cloudPinKey(pin))).toEqual(pin)
  })

  test("session pin tuples are never read as cloud pins", () => {
    expect(parseCloudPin(JSON.stringify(["/Users/m/editspaces/x", "ses_abc"]))).toBeUndefined()
  })

  test("stored pins drop malformed entries and duplicates", () => {
    const key = cloudPinKey(pin)
    expect(readCloudPins(JSON.stringify([key, key, "nope", 3, JSON.stringify(["wingman", "", "x"])]))).toEqual([key])
  })

  test("unreadable storage yields no pins", () => {
    expect(readCloudPins("{")).toEqual([])
    expect(readCloudPins(null)).toEqual([])
  })

  test("toggling adds an unpinned lane and removes a pinned one", () => {
    const added = toggledCloudPins([], pin)
    expect(added).toEqual([cloudPinKey(pin)])
    expect(toggledCloudPins(added, pin)).toEqual([])
  })
})

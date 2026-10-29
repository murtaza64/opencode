import { describe, expect, test } from "bun:test"
import { surfaceKindLabel, surfaceTags } from "./surface-tags"

describe("surfaceTags", () => {
  test("keeps the author's form and known accents in a fixed order", () => {
    expect(surfaceTags({ form: "document", accents: ["live", "interactive"] })).toEqual({ form: "document", accents: ["interactive", "live"] })
  })
  test("untagged and unknown values stay untagged", () => {
    expect(surfaceTags({})).toEqual({ form: undefined, accents: [] })
    expect(surfaceTags({ form: "report", accents: ["sparkly", 3] })).toEqual({ form: undefined, accents: [] })
  })
  test("labels read as form then accents, or plain surface", () => {
    expect(surfaceKindLabel({ form: "prototype", accents: ["interactive"] })).toBe("prototype, interactive")
    expect(surfaceKindLabel({ kind: "url" })).toBe("surface")
  })
})

// fork(session-umbrella): pure chip tests for the picker's umbrella view.
import { describe, expect, test } from "bun:test"
import { memberChips, type UmbrellaMember, type UmbrellaSession } from "../../src/fork/umbrella"

function session(id: string, kind: UmbrellaMember["kind"], label?: string): UmbrellaSession {
  const name = label ?? kind
  return {
    id,
    title: id,
    time: { created: 0, updated: 0 },
    umbrella: "demo",
    member: { directory: `/tmp/${name}`, label: name, kind },
  } as UmbrellaSession
}

describe("memberChips", () => {
  test("mixed umbrella: lane:<name>, editspace, and root chips", () => {
    const chips = memberChips([
      session("a", "root"),
      session("b", "lane", "fork-dev-loop"),
      session("c", "sidecar"),
    ])
    expect(chips.get("a")).toBe("root")
    expect(chips.get("b")).toBe("lane:fork-dev-loop")
    expect(chips.get("c")).toBe("editspace")
  })

  test("multi-repo umbrella: mirror sessions get a mirror chip", () => {
    const chips = memberChips([
      session("a", "root"),
      session("b", "lane", "esd-rollout"),
      session("c", "mirror"),
    ])
    expect(chips.get("b")).toBe("lane:esd-rollout")
    expect(chips.get("c")).toBe("mirror")
  })

  test("root + mirror only still disambiguates (mirror is not root)", () => {
    const chips = memberChips([session("a", "root"), session("b", "mirror")])
    expect(chips.get("a")).toBe("root")
    expect(chips.get("b")).toBe("mirror")
  })

  test("all-root umbrella (no editspace machinery in play): no chips at all", () => {
    const chips = memberChips([session("a", "root"), session("b", "root")])
    expect(chips.size).toBe(0)
  })

  test("no umbrella: empty map, stock behavior", () => {
    expect(memberChips(undefined).size).toBe(0)
  })
})

import { expect, test } from "bun:test"
import { anchorHref, anchorNote, anchorRange, anchorValid, parseAnchor } from "./message-anchor"

test("parses a single message and a range from session search params", () => {
  expect(parseAnchor({ directory: "/repo" } as { message?: string })).toBeUndefined()
  expect(parseAnchor({ message: "msg_a" })).toEqual({ message: "msg_a" })
  expect(parseAnchor({ message: "msg_a", to: "msg_c" })).toEqual({ message: "msg_a", to: "msg_c" })
  expect(parseAnchor({ message: "msg_a", to: "msg_a" })).toEqual({ message: "msg_a" })
  expect(parseAnchor({ message: ["msg_a", "msg_b"] })).toEqual({ message: "msg_a" })
})

test("builds the link shape briefs emit", () => {
  expect(anchorHref("ses_x", "/Users/me/proj", "msg_a")).toBe("/session/ses_x?directory=%2FUsers%2Fme%2Fproj&message=msg_a")
  expect(anchorHref("ses_x", "/p", "msg_a", "msg_c")).toBe("/session/ses_x?directory=%2Fp&message=msg_a&to=msg_c")
})

test("a range covers both ends inclusively in transcript order, given in either order", () => {
  const ids = ["msg_a", "msg_b", "msg_c", "msg_d"]
  expect(anchorRange(ids, { message: "msg_b", to: "msg_d" }, () => true)).toEqual(["msg_b", "msg_c", "msg_d"])
  expect(anchorRange(ids, { message: "msg_d", to: "msg_b" }, () => true)).toEqual(["msg_b", "msg_c", "msg_d"])
  expect(anchorRange(ids, { message: "msg_c" }, () => true)).toEqual(["msg_c"])
})

test("a range with one unknown end highlights the known end only", () => {
  const ids = ["msg_a", "msg_b", "msg_c"]
  expect(anchorRange(ids, { message: "msg_b", to: "msg_zz" }, (id) => id !== "msg_zz")).toEqual(["msg_b"])
  expect(anchorRange(ids, { message: "msg_zz" }, (id) => id !== "msg_zz")).toEqual([])
})

test("notes describe only what could not be shown", () => {
  expect(anchorNote({ message: "msg_a" }, [], false)).toBe("")
  expect(anchorNote({ message: "msg_a" }, ["msg_a"], false)).toContain("Linked message isn't in this session")
  expect(anchorNote({ message: "msg_a", to: "msg_b" }, ["msg_a", "msg_b"], false)).toContain("Linked messages aren't")
  expect(anchorNote({ message: "msg_a", to: "msg_b" }, ["msg_b"], false)).toContain("End of the linked range")
  expect(anchorNote({ message: "msg_a", to: "msg_b" }, ["msg_a"], false)).toContain("Start of the linked range")
  expect(anchorNote({ message: "msg_a" }, [], true)).toContain("Couldn't load")
})

test("only path-safe message IDs are looked up", () => {
  expect(anchorValid("msg_e9bfe2342ffeWB326ejIzTPrmW")).toBe(true)
  expect(anchorValid("../x")).toBe(false)
  expect(anchorValid("")).toBe(false)
})

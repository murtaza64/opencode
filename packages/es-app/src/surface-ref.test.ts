import { expect, test } from "bun:test"
import { citedRevision, formatSurfaceRef, localWorkKey, parseSurfaceRef, remoteGap, surfaceRefFromRoute, surfaceRefHref } from "./surface-ref"

// Shared vectors for every client that parses or formats the ref (es-app, Desk, composer chips).
const VECTORS = {
  valid: [
    ["mini~surface:opencode-feedback-fixture", { host: "mini", id: "opencode-feedback-fixture" }],
    ["mini~surface:opencode-feedback-fixture@r4", { host: "mini", id: "opencode-feedback-fixture", revision: 4 }],
    ["laptop~surface:a", { host: "laptop", id: "a" }],
    ["surface:board-1", { id: "board-1" }],
    ["surface:board-1@r12", { id: "board-1", revision: 12 }],
  ],
  invalid: [
    "mini~surface:Opencode", "Mini~surface:x", "mini~surface:-x", "mini~surface:", "mini~surface:x@r0", "mini~surface:x@r",
    "mini~surface:x@4", "mini~attention:opencode:abc", "mini~surface%3Ax", " mini~surface:x", "mini~~surface:x",
    "1mini~surface:x", "mini~surface:x/y", `mini~surface:${"a".repeat(41)}`, `${"h".repeat(33)}~surface:x`,
  ],
} as const

test("refs parse and format both ways", () => {
  for (const [token, ref] of VECTORS.valid) {
    expect(parseSurfaceRef(token)).toEqual(ref)
    expect(formatSurfaceRef(ref)).toBe(token)
  }
  for (const token of VECTORS.invalid) expect(parseSurfaceRef(token)).toBeUndefined()
})

test("a cite link carries the ref with its revision as &rev, and the route reads back to the same ref", () => {
  expect(surfaceRefHref({ host: "mini", id: "opencode-feedback-fixture", revision: 4 })).toBe("/?item=mini~surface%3Aopencode-feedback-fixture&rev=4")
  expect(surfaceRefHref({ id: "x" })).toBe("/?item=surface%3Ax")
  expect(surfaceRefFromRoute("mini~surface:opencode-feedback-fixture", undefined, "4")).toEqual({ host: "mini", id: "opencode-feedback-fixture", revision: 4 })
  expect(surfaceRefFromRoute(undefined, "x", undefined)).toEqual({ id: "x" })
  expect(surfaceRefFromRoute("mini~surface:x", undefined, "0")).toEqual({ host: "mini", id: "x" })
  expect(surfaceRefFromRoute("mini~attention:opencode:1", undefined, undefined)).toBeUndefined()
})

test("a ref naming this host opens as this host's own item; another host's stays remote", () => {
  expect(localWorkKey("mini~surface:x", "mini")).toBe("surface:x")
  expect(localWorkKey("mini~attention:opencode:1", "mini")).toBe("attention:opencode:1")
  expect(localWorkKey("mini~surface:x", "laptop")).toBe("mini~surface:x")
  expect(localWorkKey("mini~surface:x", undefined)).toBe("mini~surface:x")
  expect(localWorkKey("surface:x", "mini")).toBe("surface:x")
})

test("a cited revision other than the current one is said plainly, never shown as the current copy", () => {
  expect(citedRevision(undefined, 5)).toBeUndefined()
  expect(citedRevision(5, 5)).toBeUndefined()
  expect(citedRevision(4, 5)?.kind).toBe("older")
  expect(citedRevision(4, 5)?.text).toContain("rev 4 is no longer available")
  expect(citedRevision(7, 5)?.kind).toBe("unpublished")
})

test("another host's Surface that cannot be shown says why", () => {
  expect(remoteGap({ host: "pc", known: false, current: false })).toContain("not a Work host")
  expect(remoteGap({ host: "mini", label: "Mac Mini", known: true, current: false })).toContain("Mac Mini is not answering")
  expect(remoteGap({ host: "mini", label: "Mac Mini", known: true, current: true })).toContain("withdrawn, or never published")
})

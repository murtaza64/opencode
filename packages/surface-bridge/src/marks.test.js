import { expect, test } from "bun:test"
import { describeShapes, isValidMark, normRoute, paintShape, toDocShapes } from "./marks.js"

const mark = (shapes, extra = {}) => Object.assign({ frame: "anchor", ref: "a1", state: "", s: "", shapes }, extra)

test("a well-formed anchor mark with every tool is valid", () => {
  expect(isValidMark(mark([
    { tool: "pin", pts: [0.5, 0.5] },
    { tool: "pen", pts: [0, 0, 0.2, 0.3, 0.4, 0.1] },
    { tool: "arrow", pts: [0, 0, 1, 1] },
    { tool: "rect", pts: [-1, -1, 2, 2] },
    { tool: "ellipse", pts: [0.1, 0.1, 0.9, 0.9] },
  ]))).toBe(true)
})

test("anchor points outside [-1, 2] are rejected; doc points use pixel bounds", () => {
  expect(isValidMark(mark([{ tool: "pin", pts: [2.01, 0] }]))).toBe(false)
  expect(isValidMark(mark([{ tool: "pin", pts: [500, 900] }], { frame: "doc" }))).toBe(true)
  expect(isValidMark(mark([{ tool: "pin", pts: [0, 1e6 + 1] }], { frame: "doc" }))).toBe(false)
})

test("wrong coordinate counts, unknown tools and non-finite numbers are rejected", () => {
  expect(isValidMark(mark([{ tool: "pin", pts: [0, 0, 1, 1] }]))).toBe(false)
  expect(isValidMark(mark([{ tool: "pen", pts: [0, 0, 1] }]))).toBe(false)
  expect(isValidMark(mark([{ tool: "pen", pts: Array(402).fill(0) }]))).toBe(false)
  expect(isValidMark(mark([{ tool: "rect", pts: [0, 0, 1] }]))).toBe(false)
  expect(isValidMark(mark([{ tool: "star", pts: [0, 0] }]))).toBe(false)
  expect(isValidMark(mark([{ tool: "pin", pts: [NaN, 0] }]))).toBe(false)
  expect(isValidMark(mark([{ tool: "pin", pts: ["0", 0] }]))).toBe(false)
})

test("a mark needs 1 to 20 shapes, bounded strings and a known frame", () => {
  expect(isValidMark(mark([]))).toBe(false)
  expect(isValidMark(mark(Array(21).fill({ tool: "pin", pts: [0, 0] })))).toBe(false)
  expect(isValidMark(mark(Array(20).fill({ tool: "pin", pts: [0, 0] })))).toBe(true)
  expect(isValidMark(mark([{ tool: "pin", pts: [0, 0] }], { ref: "x".repeat(301) }))).toBe(false)
  expect(isValidMark(mark([{ tool: "pin", pts: [0, 0] }], { state: "x".repeat(501) }))).toBe(false)
  expect(isValidMark(mark([{ tool: "pin", pts: [0, 0] }], { s: "x".repeat(201) }))).toBe(false)
  expect(isValidMark(mark([{ tool: "pin", pts: [0, 0] }], { s: undefined }))).toBe(false)
  expect(isValidMark(mark([{ tool: "pin", pts: [0, 0] }], { frame: "page" }))).toBe(false)
  expect(isValidMark(null)).toBe(false)
})

test("the text alternative counts tools in plain words", () => {
  expect(describeShapes(mark([{ tool: "rect", pts: [0, 0, 1, 1] }, { tool: "rect", pts: [0, 0, 1, 1] }, { tool: "arrow", pts: [0, 0, 1, 1] }]))).toBe("2 boxes, arrow")
  expect(describeShapes(mark([{ tool: "pen", pts: [0, 0, 1, 1] }, { tool: "pen", pts: [0, 0, 1, 1] }, { tool: "ellipse", pts: [0, 0, 1, 1] }, { tool: "pin", pts: [0, 0] }]))).toBe("2 freehands, circle, pin")
})

test("routes compare by path only", () => {
  expect(normRoute("#/repo/x?t=20")).toBe("repo/x")
  expect(normRoute("")).toBe("")
  expect(normRoute("#")).toBe("")
  expect(normRoute("#/")).toBe("")
})

test("anchor fractions map onto the anchor's document box; doc points pass through", () => {
  expect(toDocShapes(mark([{ tool: "rect", pts: [0, 0, 0.5, 1] }]), { x: 100, y: 200, w: 40, h: 10 })).toEqual([{ tool: "rect", pts: [100, 200, 120, 210] }])
  expect(toDocShapes(mark([{ tool: "pin", pts: [7, 9] }], { frame: "doc" }), { x: 100, y: 200, w: 40, h: 10 })).toEqual([{ tool: "pin", pts: [7, 9] }])
})

// Just enough SVG document to record what paintShape builds.
const fakeGroup = () => {
  const children = []
  const ownerDocument = { createElementNS: (ns, name) => ({ ns, name, attrs: {}, setAttribute(key, value) { this.attrs[key] = value } }) }
  return { ownerDocument, children, appendChild: (node) => children.push(node) }
}

test("a shape paints as a white halo under its coloured stroke", () => {
  const group = fakeGroup()
  paintShape(group, { tool: "pen", pts: [1, 2, 3, 4, 5, 6] }, "#d7263d", 3, false)
  expect(group.children.map((node) => [node.name, node.attrs.stroke, node.attrs["stroke-width"], node.attrs.d])).toEqual([
    ["path", "#fff", "6", "M1.0 2.0 L3.0 4.0 L5.0 6.0"],
    ["path", "#d7263d", "3", "M1.0 2.0 L3.0 4.0 L5.0 6.0"],
  ])
  expect(group.children[0].ns).toBe("http://www.w3.org/2000/svg")
})

test("rect and ellipse paint from their two corners; dashed applies to the colour stroke only", () => {
  const group = fakeGroup()
  paintShape(group, { tool: "rect", pts: [30, 40, 10, 20] }, "#1453a3", 3, true)
  paintShape(group, { tool: "ellipse", pts: [0, 0, 20, 10] }, "#1453a3", 3, false)
  expect(group.children[0].attrs).toMatchObject({ x: "10", y: "20", width: "20", height: "20", rx: "4" })
  expect(group.children[0].attrs["stroke-dasharray"]).toBeUndefined()
  expect(group.children[1].attrs["stroke-dasharray"]).toBe("6 5")
  expect(group.children[2].attrs).toMatchObject({ cx: "10", cy: "5", rx: "10", ry: "5" })
})

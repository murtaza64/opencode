// Drawing marks on a Surface: the record, its validation, a plain-language description and SVG painting. Moved
// unchanged from MCR (mcr-buildinghub main.849d7f66: app/src/discussion/marks.ts and the surface-runtime bridge.js
// annotation layer). Framework-free; no store, auth or comment bodies. Contract: ../PROTOCOL.md "Marks".

export const MARK_TOOLS = ["pin", "pen", "arrow", "rect", "ellipse"]
export const MAX_SHAPES = 20
/** Numbers per pen stroke (200 points). */
export const MAX_PEN = 400

const isNum = (value) => typeof value === "number" && Number.isFinite(value)

/** One shape with a known tool, the right number of coordinates for it, every coordinate finite and in [lo, hi]. */
export const isValidShape = (shape, lo, hi) =>
  !!shape &&
  MARK_TOOLS.includes(shape.tool) &&
  Array.isArray(shape.pts) &&
  (shape.tool === "pin"
    ? shape.pts.length === 2
    : shape.tool === "pen"
      ? shape.pts.length >= 4 && shape.pts.length <= MAX_PEN && shape.pts.length % 2 === 0
      : shape.pts.length === 4) &&
  shape.pts.every((value) => isNum(value) && value >= lo && value <= hi)

/** Bounded, well-formed geometry only; anything else is ignored, never drawn. Anchor-frame points are fractions of
 * the anchor's box in [-1, 2]; doc-frame points (legacy, still drawn, no longer written) are document pixels. */
export const isValidMark = (mark) =>
  !!mark &&
  (mark.frame === "anchor" || mark.frame === "doc") &&
  typeof mark.ref === "string" &&
  mark.ref.length <= 300 &&
  typeof mark.state === "string" &&
  mark.state.length <= 500 &&
  typeof mark.s === "string" &&
  mark.s.length <= 200 &&
  Array.isArray(mark.shapes) &&
  mark.shapes.length >= 1 &&
  mark.shapes.length <= MAX_SHAPES &&
  mark.shapes.every((shape) => (mark.frame === "anchor" ? isValidShape(shape, -1, 2) : isValidShape(shape, -1e5, 1e6)))

const TOOL_NAMES = { arrow: "arrow", ellipse: "circle", pen: "freehand", pin: "pin", rect: "box" }

/** The text alternative for a mark's drawing, e.g. "2 boxes, arrow". */
export const describeShapes = (mark) => {
  const counts = {}
  mark.shapes.forEach((shape) => (counts[TOOL_NAMES[shape.tool]] = (counts[TOOL_NAMES[shape.tool]] || 0) + 1))
  return Object.entries(counts)
    .map(([name, count]) => (count > 1 ? `${count} ${name}${name === "box" ? "es" : "s"}` : name))
    .join(", ")
}

/** In-frame route (the page's own #hash) reduced to its path for comparison: "#/repo/x?t=20" -> "repo/x"; "", "#"
 * and "#/" are the default view. Marks drawn on one route are not shown on another. */
export const normRoute = (hash) => hash.replace(/^#/, "").split("?")[0].replace(/^\/+|\/+$/g, "")

/** A valid mark's shapes in document pixels, given its anchor's box in document pixels. */
export const toDocShapes = (mark, box) =>
  mark.shapes.map((shape) => ({
    tool: shape.tool,
    pts: mark.frame === "anchor" ? shape.pts.map((value, i) => (i % 2 ? box.y + value * box.h : box.x + value * box.w)) : shape.pts.slice(),
  }))

const SVGNS = "http://www.w3.org/2000/svg"

/** Draw one non-pin shape (document pixels) into `group`, twice: a white halo under a coloured stroke, so it reads
 * over light and dark content. Builds elements from validated numbers only, never markup. */
export const paintShape = (group, shape, color, width, dashed) => {
  const doc = group.ownerDocument
  const add = (name, attrs) => {
    const node = doc.createElementNS(SVGNS, name)
    Object.keys(attrs).forEach((key) => node.setAttribute(key, String(attrs[key])))
    group.appendChild(node)
  }
  const p = shape.pts
  ;[["#fff", width + 3], [color, width]].forEach(([stroke, w]) => {
    const common = { fill: "none", stroke, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" }
    if (dashed && stroke !== "#fff") common["stroke-dasharray"] = "6 5"
    if (shape.tool === "pen") {
      const d = p.reduce((path, value, i) => (i % 2 ? path : `${path}${i ? " L" : "M"}${value.toFixed(1)} ${p[i + 1].toFixed(1)}`), "")
      return add("path", Object.assign({ d }, common))
    }
    if (shape.tool === "rect")
      return add("rect", Object.assign({ x: Math.min(p[0], p[2]), y: Math.min(p[1], p[3]), width: Math.abs(p[2] - p[0]), height: Math.abs(p[3] - p[1]), rx: 4 }, common))
    if (shape.tool === "ellipse")
      return add("ellipse", Object.assign({ cx: (p[0] + p[2]) / 2, cy: (p[1] + p[3]) / 2, rx: Math.abs(p[2] - p[0]) / 2, ry: Math.abs(p[3] - p[1]) / 2 }, common))
    if (shape.tool === "arrow") {
      const angle = Math.atan2(p[3] - p[1], p[2] - p[0])
      const head = 10 + w
      const hx = (a) => p[2] - head * Math.cos(angle + a)
      const hy = (a) => p[3] - head * Math.sin(angle + a)
      add("path", Object.assign({ d: `M${p[0]} ${p[1]} L${p[2]} ${p[3]} M${hx(0.5)} ${hy(0.5)} L${p[2]} ${p[3]} L${hx(-0.5)} ${hy(-0.5)}` }, common))
    }
  })
}

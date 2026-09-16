type Point = { pos: number; left: number; top: number; height: number; row: number }
type Layout = { points: Point[]; rows: Point[][]; lines: { pos: number; top: number }[]; lineHeight: number }

const properties = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-transform",
  "text-align",
  "direction",
  "unicode-bidi",
  "tab-size",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "white-space",
  "word-break",
  "overflow-wrap",
] as const
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
let mirror: HTMLDivElement | undefined
let cached: { target: HTMLTextAreaElement; value: string; style: string; layout: Layout } | undefined

export const invalidateTextareaLayout = () => {
  cached = undefined
}

// A single mirror bounds retained DOM. Ranges share one layout pass; no growing
// prefixes or per-character DOM edits. Selection/scroll changes reuse the map.
export const textareaLayout = (target: HTMLTextAreaElement): Layout => {
  const computed = getComputedStyle(target)
  const style =
    properties.map((name) => `${name}:${computed.getPropertyValue(name)};`).join("") + `width:${target.clientWidth}px;`
  if (cached?.target === target && cached.value === target.value && cached.style === style) return cached.layout
  mirror ??= document.createElement("div")
  mirror.style.cssText =
    style + "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;border:0;"
  if (!mirror.isConnected) document.body.append(mirror)
  // The sentinel gives empty and trailing-newline buffers a measurable last row.
  const text = document.createTextNode(target.value + "\u200b")
  mirror.replaceChildren(text)
  const origin = mirror.getBoundingClientRect()
  const range = document.createRange()
  const points: Point[] = []
  const rows: Point[][] = []
  const lines: Layout["lines"] = []
  const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.2
  for (const part of segmenter.segment(text.data)) {
    range.setStart(text, part.index)
    range.setEnd(text, part.index + part.segment.length)
    const rect = range.getClientRects()[0]!
    range.collapse(true)
    const caret = Array.from(range.getClientRects()).find((caret) => Math.abs(caret.top - rect.top) < 1)
    const top = rect.top - origin.top
    const row = rows.length && top > rows.at(-1)![0]!.top + lineHeight / 2 ? rows.length : Math.max(0, rows.length - 1)
    const point = { pos: part.index, left: (caret?.left ?? rect.left) - origin.left, top, height: rect.height, row }
    points.push(point)
    ;(rows[row] ??= []).push(point)
    if (part.index === 0 || target.value[part.index - 1] === "\n") lines.push({ pos: part.index, top })
  }
  const layout = { points, rows, lines, lineHeight }
  cached = { target, value: target.value, style, layout }
  return layout
}

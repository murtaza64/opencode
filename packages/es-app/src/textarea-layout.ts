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
  probed = undefined
}

const styleOf = (target: HTMLTextAreaElement, computed: CSSStyleDeclaration) =>
  properties.map((name) => `${name}:${computed.getPropertyValue(name)};`).join("") + `width:${target.clientWidth}px;`
const OFFSCREEN = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;border:0;"

let probe: HTMLDivElement | undefined
let probed: { target: HTMLTextAreaElement; style: string; value: string; text: Text; starts?: number[] } | undefined

/** Positions measured on demand (DD #432). `textareaLayout` measures every grapheme, and each Range rect in a long
 * text node costs more as the text grows, so a full layout per keystroke was quadratic in the draft (14 s per key at
 * 200k chars). This keeps its own mirror in step with the textarea (only the edited span is replaced) and measures
 * just the positions a caller asks for: a line number gutter, a caret or a chip costs a few rects per keystroke. */
export const textareaProbe = (target: HTMLTextAreaElement) => {
  const computed = getComputedStyle(target)
  const style = styleOf(target, computed)
  const value = target.value
  if (probed?.target !== target || probed.style !== style) {
    probe ??= document.createElement("div")
    probe.style.cssText = style + OFFSCREEN
    // The sentinel gives empty and trailing-newline buffers a measurable last row.
    const text = document.createTextNode(value + "\u200b")
    probe.replaceChildren(text)
    probed = { target, style, value, text }
  } else if (probed.value !== value) {
    const old = probed.value
    const max = Math.min(old.length, value.length)
    let head = 0
    while (head < max && old.charCodeAt(head) === value.charCodeAt(head)) head++
    let tail = 0
    while (tail < max - head && old.charCodeAt(old.length - 1 - tail) === value.charCodeAt(value.length - 1 - tail)) tail++
    probed.text.replaceData(head, old.length - head - tail, value.slice(head, value.length - tail))
    probed = { ...probed, value, starts: undefined }
  }
  if (!probe!.isConnected) document.body.append(probe!)
  const current = probed
  const origin = probe!.getBoundingClientRect()
  const range = document.createRange()
  const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.2
  /** The grapheme at `pos` (a grapheme boundary; the text's length means the end), as `textareaLayout` measures it. */
  const point = (pos: number) => {
    const at = Math.max(0, Math.min(pos, value.length))
    const first = at < value.length ? segmenter.segment(value.slice(at, at + 32))[Symbol.iterator]().next().value : undefined
    range.setStart(current.text, at)
    range.setEnd(current.text, at + (first?.segment.length ?? 1))
    const rect = range.getClientRects()[0]!
    range.collapse(true)
    const caret = Array.from(range.getClientRects()).find((item) => Math.abs(item.top - rect.top) < 1)
    return { pos: at, left: (caret?.left ?? rect.left) - origin.left, top: rect.top - origin.top, height: rect.height }
  }
  /** Each row's box of the text from `start` to `end`, relative to the mirror (first row first). */
  const rects = (start: number, end: number) => {
    range.setStart(current.text, Math.max(0, Math.min(start, value.length)))
    range.setEnd(current.text, Math.max(0, Math.min(end, value.length)))
    return Array.from(range.getClientRects()).map((item) => ({ left: item.left - origin.left, top: item.top - origin.top, width: item.width, height: item.height }))
  }
  /** Where each logical line starts (0, and after every newline); a string scan, no layout. */
  const lineStarts = () => {
    if (current.starts) return current.starts
    const starts = [0]
    for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1)) starts.push(index + 1)
    current.starts = starts
    return starts
  }
  return { point, rects, lineStarts, lineHeight }
}

// A single mirror bounds retained DOM. Ranges share one layout pass; no growing
// prefixes or per-character DOM edits. Selection/scroll changes reuse the map.
export const textareaLayout = (target: HTMLTextAreaElement): Layout => {
  const computed = getComputedStyle(target)
  const style = styleOf(target, computed)
  if (cached?.target === target && cached.value === target.value && cached.style === style) return cached.layout
  mirror ??= document.createElement("div")
  mirror.style.cssText = style + OFFSCREEN
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

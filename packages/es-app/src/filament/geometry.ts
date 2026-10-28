/* Rects for the nodes the adapter produced, read from attributes the transcript already renders
 * (`data-find-message`, `data-timeline-part-id(s)`, the permission banner / question card, the
 * `.thinking` tail). All coordinates are CSS px relative to the transcript's border box, which
 * is also the canvas origin; the canvas covers exactly that box. The transcript's padding offsets
 * the sticky holder, so the holder (not the transcript) is the origin. */
import type { Node } from "./adapter"

export type Rect = { x: number; y: number; w: number; h: number; cx: number; cy: number }
export type Layout = {
  w: number
  h: number
  sign: 1 | -1
  // Physical x of the thread, in the gutter the transcript reserves while the filament is on.
  gx: number
  rects: Map<string, Rect>
  composerTop: number
  thinking?: Rect
}

const rel = (root: DOMRect, r: DOMRect): Rect => ({ x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height, cx: r.left - root.left + r.width / 2, cy: r.top - root.top + r.height / 2 })

const sel = (node: Node) => node.anchor === "message" ? `[data-find-message="${CSS.escape(node.id)}"] [data-component="user-message"], [data-find-message="${CSS.escape(node.id)}"]`
  : node.anchor === "part" ? `[data-timeline-part-id="${CSS.escape(node.id)}"], [data-timeline-part-ids~="${CSS.escape(node.id)}"], [data-timeline-part-ids*="${CSS.escape(node.id)}"]`
  : `.question-round[data-question-request="${CSS.escape(node.id)}"], .banner.permission`

export const measure = (transcript: HTMLElement, origin: HTMLElement, nodes: readonly Node[], gutter: number): Layout => {
  // Origin is the sticky holder (canvas top-left); its rect and the rows' rects share any overscroll translation.
  const o = origin.getBoundingClientRect()
  const t = transcript.getBoundingClientRect()
  const root = new DOMRect(o.left, o.top, t.width, transcript.clientHeight)
  const rtl = getComputedStyle(transcript).direction === "rtl"
  const inner = transcript.querySelector<HTMLElement>(".transcript-inner")?.getBoundingClientRect() ?? root
  const rects = new Map<string, Rect>()
  // Only what is near the viewport is measured; offscreen nodes are skipped by the scene anyway.
  for (const node of nodes) {
    const el = transcript.querySelector<HTMLElement>(sel(node))
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.bottom < root.top - 200 || r.top > root.bottom + 200) continue
    rects.set(node.id, rel(root, r))
  }
  const thinking = transcript.querySelector<HTMLElement>(".thinking")?.getBoundingClientRect()
  return {
    w: root.width,
    h: root.height,
    sign: rtl ? -1 : 1,
    gx: rtl ? inner.right - root.left + gutter / 2 : inner.left - root.left - gutter / 2,
    rects,
    composerTop: root.height,
    thinking: thinking ? rel(root, thinking) : undefined,
  }
}

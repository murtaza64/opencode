// Where a host puts its comment card and anchor emphasis over a Surface, in stage pixels. Moved unchanged from es-app
// M1 (packages/es-app/src/components/surface-comments.tsx at opencode dev 3a29bae2). Pure: no DOM, framework or store.

/** Defaults: gap to the anchor, margin to the stage edge, preferred room on one side, the smallest room worth using,
 * the tallest card, the card's width, and the padding around the anchor. */
export const CARD = { gap: 10, edge: 8, room: 260, min: 180, max: 460, width: 360, pad: 6 }

/** The anchor's box grown by `pad` and clipped to the stage: the outline, and the hole in any emphasis around it. */
export const focusHole = (box, stage, pad = CARD.pad) => ({
  x: Math.max(0, box.x - pad),
  y: Math.max(0, box.y - pad),
  r: Math.min(stage.w, box.x + box.w + pad),
  b: Math.min(stage.h, box.y + box.h + pad),
})

/** The card takes the side with room (below unless above has more), capped to that room so its reply box and actions
 * stay on screen; its thread scrolls inside. With no usable room on either side it sits over the bottom of the stage.
 * Returns CSS pixel values: `left`, then `top` or `bottom`, and `maxBlockSize`. */
export const placeCard = (box, stage, options = {}) => {
  const o = Object.assign({}, CARD, options)
  const hole = focusHole(box, stage, o.pad)
  const roomBelow = stage.h - hole.b - o.gap - o.edge
  const roomAbove = hole.y - o.gap - o.edge
  const below = roomBelow >= o.room || roomBelow >= roomAbove
  const room = below ? roomBelow : roomAbove
  const left = Math.max(o.edge, Math.min(stage.w - o.width - o.edge, box.x))
  if (room < o.min) return { below, left, bottom: o.edge, maxBlockSize: Math.min(o.max, stage.h - 2 * o.edge) }
  const maxBlockSize = Math.min(o.max, room)
  return below ? { below, left, top: hole.b + o.gap, maxBlockSize } : { below, left, bottom: stage.h - hole.y + o.gap, maxBlockSize }
}

/** Four rectangles covering the stage around `hole` (top, bottom, start, end), for hosts that dim around the anchor.
 * H629 (no blocking pop-up) means a host should not make them block input. */
export const maskRects = (hole, stage) => [
  { x: 0, y: 0, w: stage.w, h: hole.y },
  { x: 0, y: hole.b, w: stage.w, h: stage.h - hole.b },
  { x: 0, y: hole.y, w: hole.x, h: hole.b - hole.y },
  { x: hole.r, y: hole.y, w: stage.w - hole.r, h: hole.b - hole.y },
]

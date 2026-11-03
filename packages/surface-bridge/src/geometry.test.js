import { expect, test } from "bun:test"
import { focusHole, maskRects, placeCard } from "./geometry.js"

const stage = { w: 1000, h: 800 }

test("the hole pads the anchor and stays inside the stage", () => {
  expect(focusHole({ x: 100, y: 50, w: 200, h: 40 }, stage)).toEqual({ x: 94, y: 44, r: 306, b: 96 })
  expect(focusHole({ x: 2, y: 3, w: 2000, h: 2000 }, stage)).toEqual({ x: 0, y: 0, r: 1000, b: 800 })
})

test("the card goes below the anchor when there is room, capped at the tallest card", () => {
  expect(placeCard({ x: 100, y: 50, w: 200, h: 40 }, stage)).toEqual({ below: true, left: 100, top: 106, maxBlockSize: 460 })
})

test("the card goes above when below is short and above has more room", () => {
  // Hole bottom 756: 26 px below; hole top 594: 576 px above.
  expect(placeCard({ x: 100, y: 600, w: 200, h: 150 }, stage)).toEqual({ below: false, left: 100, bottom: 216, maxBlockSize: 460 })
})

test("with no usable room on either side the card sits over the bottom of the stage", () => {
  // Hole 144..716: 66 px below, 126 px above, both under the 180 px minimum.
  expect(placeCard({ x: 100, y: 150, w: 200, h: 560 }, { w: 1000, h: 800 })).toEqual({ below: false, left: 100, bottom: 8, maxBlockSize: 460 })
})

test("the card stays inside the stage edges horizontally", () => {
  expect(placeCard({ x: 900, y: 50, w: 50, h: 20 }, stage).left).toBe(632)
  expect(placeCard({ x: -40, y: 50, w: 50, h: 20 }, stage).left).toBe(8)
})

test("the mask covers the stage around the hole in four pieces", () => {
  expect(maskRects({ x: 94, y: 44, r: 306, b: 96 }, stage)).toEqual([
    { x: 0, y: 0, w: 1000, h: 44 },
    { x: 0, y: 96, w: 1000, h: 704 },
    { x: 0, y: 44, w: 94, h: 52 },
    { x: 306, y: 44, w: 694, h: 52 },
  ])
})

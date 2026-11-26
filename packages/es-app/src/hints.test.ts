import { expect, test } from "bun:test"
import { hintLabels } from "./hints"

test.each([3, 23, 24, 40, 200, 529])("%i labels are unique and none is a prefix of another", (count) => {
  const labels = hintLabels(count)
  expect(labels).toHaveLength(count)
  expect(new Set(labels).size).toBe(count)
  expect(labels.some((label) => labels.some((other) => other !== label && other.startsWith(label)))).toBe(false)
})

test("single letters while they fit; past that, the first-ranked targets keep one letter", () => {
  expect(hintLabels(3)).toEqual(["a", "s", "d"])
  expect(hintLabels(40).filter((label) => label.length === 1)).toHaveLength(22)
})

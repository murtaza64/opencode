import { expect, test } from "bun:test"
import { gaussianBlur } from "./appearance"
import { blurOffMain } from "./blur-worker"

const image = (width: number, height: number) => new Uint8Array(width * height * 4).map((_, index) => (index * 37) % 251)

test("the worker's blur equals the inline blur and leaves the input unchanged", async () => {
  const input = image(64, 48)
  const before = input.slice()
  const result = await blurOffMain(input, 64, 48, 3)
  expect(result).toEqual(gaussianBlur(before.slice(), 64, 48, 3))
  expect(input).toEqual(before)
})

test("the main thread keeps running while a large blur is in progress", async () => {
  const ticks: number[] = []
  const timer = setInterval(() => ticks.push(performance.now()), 10)
  const started = performance.now()
  await blurOffMain(image(2048, 1152), 2048, 1152, 4)
  const elapsed = performance.now() - started
  clearInterval(timer)
  // The blur takes hundreds of milliseconds; timers fire throughout instead of after it.
  expect(elapsed).toBeGreaterThan(100)
  const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]!)
  expect(Math.max(...gaps)).toBeLessThan(100)
})

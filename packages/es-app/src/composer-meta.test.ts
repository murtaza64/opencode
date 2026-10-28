import { expect, test } from "bun:test"
import { footerContext, footerCost } from "./composer-meta"

test("context is a percent of the selected model's known window, levelled at 70 and 90", () => {
  expect(footerContext({ used: 182_000, limit: 200_000, selected: "Opus", turnModel: "Opus" }))
    .toEqual({ text: "91%", level: "high", title: "Context used by the latest turn: 182k of 200k (Opus)" })
  expect(footerContext({ used: 140_000, limit: 200_000 })?.level).toBe("warn")
})

test("without a known window the token count shows, never a guessed percent; no reply shows nothing", () => {
  expect(footerContext({ used: 182_000, limit: undefined, selected: "Local" })?.text).toBe("182k ctx")
  expect(footerContext({ used: undefined, limit: 200_000 })).toBeUndefined()
})

test("a turn measured on another model says so", () => {
  expect(footerContext({ used: 50_000, limit: 1_000_000, selected: "Sonnet", turnModel: "Opus" })?.title).toContain("(measured on Opus)")
})

test("cost is an estimate when recorded and unknown otherwise, never a free-looking zero", () => {
  expect(footerCost(undefined, [undefined, undefined])).toEqual({ known: false, text: "~$?" })
  expect(footerCost(12.345, [])).toEqual({ known: true, value: 12.345, text: "~$12.35", decade: 2 })
  expect(footerCost(0, [0.25, 0.5])).toMatchObject({ known: true, text: "~$0.75", decade: 0 })
  expect(footerCost(undefined, [150])).toMatchObject({ decade: 3 })
})

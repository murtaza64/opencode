import { expect, test } from "bun:test"
import { ariaShortcut, shortcutLabel } from "./shortcuts"

test.each([
  ["primaryAction", "⌘↵", "Ctrl+Enter"],
  ["submit", "⌘↵", "Ctrl+Enter"],
  ["cycleTarget", "⌘M", "Super+M"],
  ["find", "⌘F", "Ctrl+F"],
  ["previousPrompt", "⌃P", "Ctrl+P"],
  ["nextPrompt", "⌃N", "Ctrl+N"],
  ["expandEditor", "⌃E", "Ctrl+E"],
  ["toggleSessions", "⌃H", "Ctrl+H"],
] as const)("labels %s with the platform's effective chord", (id, mac, other) => {
  expect(shortcutLabel(id, "mac")).toBe(mac)
  expect(shortcutLabel(id, "other")).toBe(other)
})

test("lists both chords when the handler accepts Cmd or Ctrl", () => {
  expect(ariaShortcut("primaryAction")).toBe("Meta+Enter Control+Enter")
  expect(ariaShortcut("find")).toBe("Meta+F Control+F")
})

test("lists only the literal chord for single-modifier handlers", () => {
  expect(ariaShortcut("cycleTarget")).toBe("Meta+M")
  expect(ariaShortcut("previousPrompt")).toBe("Control+P")
  expect(ariaShortcut("expandEditor")).toBe("Control+E")
})

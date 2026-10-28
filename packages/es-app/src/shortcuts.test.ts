import { expect, test } from "bun:test"
import { ariaShortcut, matchShortcut, pinnedSlot, SEQUENCES, sequenceLabel, SHORTCUTS, shortcutLabel, type ShortcutID } from "./shortcuts"

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

test.each([
  ["sessionFinder", "⌘S", "Alt+S"],
  ["commandPalette", "⌘P", "Alt+P"],
  ["lastSession", "⌘`", "Alt+`"],
  ["pinnedSession", "⌘1–9", "Alt+1–9"],
  ["needsYou", "⇧⌘N", "Alt+Shift+N"],
  ["mruForward", "⌃⇧Tab", "Ctrl+Shift+Tab"],
  ["focusLeft", "⌃⌥H", "Ctrl+Alt+H"],
  ["previousRegion", "⇧F6", "Shift+F6"],
] as const)("labels approved app chord %s with Cmd on macOS and Alt elsewhere", (id, mac, other) => {
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

test("aria for Mod chords names the platform modifier", () => {
  expect(ariaShortcut("commandPalette", "mac")).toBe("Meta+P")
  expect(ariaShortcut("commandPalette", "other")).toBe("Alt+P")
  expect(ariaShortcut("pinnedSession", "other").split(" ")).toHaveLength(9)
})

const key = (init: Partial<KeyboardEvent> & { key: string; code: string }) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...init })

test("Primary matches Cmd or Ctrl but not both", () => {
  expect(matchShortcut(key({ key: "Enter", code: "Enter", metaKey: true }), "primaryAction", "mac")).toBe(true)
  expect(matchShortcut(key({ key: "Enter", code: "Enter", ctrlKey: true }), "primaryAction", "mac")).toBe(true)
  expect(matchShortcut(key({ key: "Enter", code: "Enter", metaKey: true, ctrlKey: true }), "primaryAction", "mac")).toBe(false)
  expect(matchShortcut(key({ key: "Enter", code: "Enter" }), "primaryAction", "mac")).toBe(false)
})

test("Mod is Cmd on macOS and Alt elsewhere", () => {
  expect(matchShortcut(key({ key: "p", code: "KeyP", metaKey: true }), "commandPalette", "mac")).toBe(true)
  expect(matchShortcut(key({ key: "p", code: "KeyP", altKey: true }), "commandPalette", "mac")).toBe(false)
  expect(matchShortcut(key({ key: "p", code: "KeyP", altKey: true }), "commandPalette", "other")).toBe(true)
  expect(matchShortcut(key({ key: "p", code: "KeyP", ctrlKey: true }), "commandPalette", "other")).toBe(false)
})

test("Option-modified letters match by physical key", () => {
  expect(matchShortcut(key({ key: "ß", code: "KeyS", altKey: true }), "sessionFinder", "other")).toBe(true)
})

test("letters follow the keyboard layout when the key is a letter", () => {
  // Dvorak: physical KeyR types "p".
  expect(matchShortcut(key({ key: "p", code: "KeyR", ctrlKey: true }), "previousPrompt", "other")).toBe(true)
  expect(matchShortcut(key({ key: "l", code: "KeyP", ctrlKey: true }), "previousPrompt", "other")).toBe(false)
})

test("extra modifiers do not match", () => {
  expect(matchShortcut(key({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }), "commandPalette", "mac")).toBe(false)
  expect(matchShortcut(key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }), "mruBack", "mac")).toBe(false)
  expect(matchShortcut(key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }), "mruForward", "mac")).toBe(true)
})

test("IME composition never matches", () => {
  expect(matchShortcut(key({ key: "Enter", code: "Enter", metaKey: true, isComposing: true }), "primaryAction", "mac")).toBe(false)
  expect(matchShortcut(key({ key: "Process", code: "Enter", metaKey: true, keyCode: 229 }), "primaryAction", "mac")).toBe(false)
})

test("pinned slot reads the digit", () => {
  expect(pinnedSlot(key({ key: "3", code: "Digit3", metaKey: true }), "mac")).toBe(3)
  expect(pinnedSlot(key({ key: "0", code: "Digit0", metaKey: true }), "mac")).toBeUndefined()
  expect(pinnedSlot(key({ key: "¡", code: "Digit1", altKey: true }), "other")).toBe(1)
})

test.each(["mac", "other"] as const)("no two chords collide on %s except the shared Enter submit", (platform) => {
  const ids = Object.keys(SHORTCUTS) as ShortcutID[]
  const chords = ids.flatMap((id) => ariaShortcut(id, platform).split(" ").map((chord) => ({ id, chord })))
  const collisions = [...new Set(chords.map((entry) => entry.chord))]
    .map((chord) => chords.filter((entry) => entry.chord === chord).map((entry) => entry.id))
    .filter((group) => group.length > 1)
  expect(collisions).toEqual([["primaryAction", "submit"], ["primaryAction", "submit"]])
})

test("no sequence is a prefix of another", () => {
  const all = Object.values(SEQUENCES).map((keys) => keys.join(" "))
  const prefixed = all.filter((a) => all.some((b) => b !== a && b.startsWith(a + " ")))
  expect(prefixed).toEqual([])
  expect(new Set(all).size).toBe(all.length)
  expect(sequenceLabel("goCloud")).toBe("g C")
})

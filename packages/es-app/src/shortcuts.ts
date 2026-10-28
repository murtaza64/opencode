/* Display labels for the keyboard bindings es-app already dispatches. Each entry
 * states the modifiers its handler actually accepts, so a hint never names a key
 * that does nothing on this platform. Handlers still own dispatch. */

export type Platform = "mac" | "other"

// "Primary" is accepted as either Meta or Control by the handler (Cmd on macOS,
// Ctrl elsewhere). "Meta" is literal: Cmd on macOS, Super/Windows elsewhere.
type Modifier = "Primary" | "Meta" | "Control" | "Alt" | "Shift"
type Binding = { modifiers: Modifier[]; key: string }

export const SHORTCUTS = {
  // Composer primary action: label follows draft and pending state (send, steer, nudge).
  primaryAction: { modifiers: ["Primary"], key: "Enter" },
  // Submit outside the composer: decisions, new session, pending-input edit.
  submit: { modifiers: ["Primary"], key: "Enter" },
  // session.tsx cycleMode checks metaKey only.
  cycleTarget: { modifiers: ["Meta"], key: "M" },
  find: { modifiers: ["Primary"], key: "F" },
  previousPrompt: { modifiers: ["Control"], key: "P" },
  nextPrompt: { modifiers: ["Control"], key: "N" },
  expandEditor: { modifiers: ["Control"], key: "E" },
  toggleSessions: { modifiers: ["Control"], key: "H" },
} satisfies Record<string, Binding>

export type ShortcutID = keyof typeof SHORTCUTS

export const currentPlatform = (): Platform =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "mac" : "other"

const MAC_GLYPH: Record<Modifier, string> = { Primary: "⌘", Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" }
const OTHER_NAME: Record<Modifier, string> = { Primary: "Ctrl", Meta: "Super", Control: "Ctrl", Alt: "Alt", Shift: "Shift" }
const MAC_KEY: Record<string, string> = { Enter: "↵" }

/** Visible hint, e.g. "⌘↵" on macOS and "Ctrl+Enter" elsewhere. */
export const shortcutLabel = (id: ShortcutID, platform = currentPlatform()) => {
  const binding: Binding = SHORTCUTS[id]
  if (platform === "mac") return binding.modifiers.map((modifier) => MAC_GLYPH[modifier]).join("") + (MAC_KEY[binding.key] ?? binding.key)
  return [...binding.modifiers.map((modifier) => OTHER_NAME[modifier]), binding.key].join("+")
}

/** `aria-keyshortcuts` value listing every chord the handler accepts. */
export const ariaShortcut = (id: ShortcutID) => {
  const binding: Binding = SHORTCUTS[id]
  const rest = binding.modifiers.filter((modifier) => modifier !== "Primary")
  const chord = (first: string[]) => [...first, ...rest, binding.key].join("+")
  if (!binding.modifiers.includes("Primary")) return chord([])
  return `${chord(["Meta"])} ${chord(["Control"])}`
}

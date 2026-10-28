/* Keyboard registry (dotfiles#254, proposal v1.2). Each entry states the modifiers
 * its handler accepts, so a hint never names a key that does nothing on this
 * platform. Only `dispatched` entries may be shown as hints; `planned` entries are
 * approved bindings whose handlers have not landed yet. */

export type Platform = "mac" | "other"

// "Primary" is accepted as either Meta or Control by the handler (Cmd on macOS,
// Ctrl elsewhere). "Mod" is the app-chord modifier: Cmd on macOS, Alt elsewhere
// (D1, kitty mirror). "Meta" is literal: Cmd on macOS, Super/Windows elsewhere.
type Modifier = "Primary" | "Mod" | "Meta" | "Control" | "Alt" | "Shift"
type Binding = { modifiers: Modifier[]; key: string; status: "dispatched" | "planned" }

const dispatched = (key: string, ...modifiers: Modifier[]): Binding => ({ modifiers, key, status: "dispatched" })
const planned = (key: string, ...modifiers: Modifier[]): Binding => ({ modifiers, key, status: "planned" })

export const SHORTCUTS = {
  // Composer primary action: label follows draft and pending state (send, steer, nudge).
  primaryAction: dispatched("Enter", "Primary"),
  // Submit outside the composer: decisions, new session, pending-input edit.
  submit: dispatched("Enter", "Primary"),
  // session.tsx cycleMode checks metaKey only (D4 adds Ctrl+M off macOS with its handler).
  cycleTarget: dispatched("M", "Meta"),
  find: dispatched("F", "Primary"),
  previousPrompt: dispatched("P", "Control"),
  nextPrompt: dispatched("N", "Control"),
  expandEditor: dispatched("E", "Control"),
  toggleSessions: dispatched("H", "Control"),
  sessionFinder: planned("S", "Mod"),
  mruBack: planned("Tab", "Control"),
  mruForward: planned("Tab", "Control", "Shift"),
  lastSession: planned("`", "Mod"),
  pinnedSession: planned("1-9", "Mod"),
  needsYou: planned("N", "Mod", "Shift"),
  commandPalette: planned("P", "Mod"),
  nextRegion: planned("F6"),
  previousRegion: planned("F6", "Shift"),
  focusLeft: planned("H", "Control", "Alt"),
  focusDown: planned("J", "Control", "Alt"),
  focusUp: planned("K", "Control", "Alt"),
  focusRight: planned("L", "Control", "Alt"),
} satisfies Record<string, Binding>

export type ShortcutID = keyof typeof SHORTCUTS

// Normal-scope key sequences (leader = Space, g table, ]x/[x pairs). Planned until
// the dispatcher lands.
export const SEQUENCES = {
  pinToggle: ["Space", "m"],
  needsYouLeader: ["Space", "n"],
  referenceLeader: ["Space", "?"],
  reference: ["?"],
  parentSession: ["g", "p"],
  childSession: ["g", "c"],
  goDesk: ["g", "d"],
  goAgents: ["g", "a"],
  goUsage: ["g", "u"],
  goCloud: ["g", "C"],
  goNewSession: ["g", "o"],
  nextPromptPair: ["]", "p"],
  previousPromptPair: ["[", "p"],
  nextDecision: ["]", "n"],
  previousDecision: ["[", "n"],
} satisfies Record<string, string[]>

export type SequenceID = keyof typeof SEQUENCES

export const currentPlatform = (): Platform =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "mac" : "other"

const MAC_GLYPH: Record<Modifier, string> = { Primary: "⌘", Mod: "⌘", Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" }
const OTHER_NAME: Record<Modifier, string> = { Primary: "Ctrl", Mod: "Alt", Meta: "Super", Control: "Ctrl", Alt: "Alt", Shift: "Shift" }
// macOS menus print modifiers as ⌃⌥⇧⌘; elsewhere Ctrl+Alt+Shift+Super.
const MAC_ORDER: Modifier[] = ["Control", "Alt", "Shift", "Primary", "Mod", "Meta"]
const OTHER_ORDER: Modifier[] = ["Control", "Primary", "Alt", "Mod", "Shift", "Meta"]
const MAC_KEY: Record<string, string> = { Enter: "↵", "1-9": "1–9" }
const OTHER_KEY: Record<string, string> = { "1-9": "1–9" }

const ordered = (modifiers: Modifier[], order: Modifier[]) => order.filter((modifier) => modifiers.includes(modifier))

/** Visible hint, e.g. "⌘↵" on macOS and "Ctrl+Enter" elsewhere. */
export const shortcutLabel = (id: ShortcutID, platform = currentPlatform()) => {
  const binding: Binding = SHORTCUTS[id]
  if (platform === "mac")
    return ordered(binding.modifiers, MAC_ORDER).map((modifier) => MAC_GLYPH[modifier]).join("") + (MAC_KEY[binding.key] ?? binding.key)
  return [...ordered(binding.modifiers, OTHER_ORDER).map((modifier) => OTHER_NAME[modifier]), OTHER_KEY[binding.key] ?? binding.key].join("+")
}

/** Visible hint for a key sequence, e.g. "Space m" or "g C". */
export const sequenceLabel = (id: SequenceID) => SEQUENCES[id].join(" ")

/** `aria-keyshortcuts` value listing every chord the handler accepts. */
export const ariaShortcut = (id: ShortcutID, platform = currentPlatform()) => {
  const binding: Binding = SHORTCUTS[id]
  const literal = binding.modifiers.flatMap((modifier) => {
    if (modifier === "Primary") return []
    if (modifier === "Mod") return [platform === "mac" ? "Meta" : "Alt"]
    return [modifier]
  })
  const keys = binding.key === "1-9" ? ["1", "2", "3", "4", "5", "6", "7", "8", "9"] : [binding.key]
  const chords = (first: string[]) => keys.map((key) => [...first, ...literal, key].join("+"))
  if (!binding.modifiers.includes("Primary")) return chords([]).join(" ")
  return [...chords(["Meta"]), ...chords(["Control"])].join(" ")
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">

/** True when the event is the binding's chord on this platform. IME composition never matches. */
export const matchShortcut = (event: KeyEventLike, id: ShortcutID, platform = currentPlatform()) => {
  if (event.isComposing || event.keyCode === 229) return false
  const binding: Binding = SHORTCUTS[id]
  const has = (modifier: Modifier) => binding.modifiers.includes(modifier)
  const mod = has("Mod")
  const primary = has("Primary") && event.metaKey !== event.ctrlKey
  const meta = has("Meta") || (mod && platform === "mac")
  const control = has("Control")
  const alt = has("Alt") || (mod && platform === "other")
  if (!primary && (event.metaKey !== meta || event.ctrlKey !== control)) return false
  if (has("Primary") && !primary) return false
  if (event.altKey !== alt || event.shiftKey !== has("Shift")) return false
  return keyMatches(binding.key, event)
}

/** 1–9 for a pinnedSession chord, otherwise undefined. */
export const pinnedSlot = (event: KeyEventLike, platform = currentPlatform()) =>
  matchShortcut(event, "pinnedSession", platform) ? Number(event.code.slice(5)) : undefined

/** Text-entry targets keep plain keys; only chords and composer keys apply there. */
export const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return !("readOnly" in target && target.readOnly)
  if (!(target instanceof HTMLInputElement)) return false
  return !target.readOnly && !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(target.type)
}

// Letters follow the layout (event.key) so Dvorak/AZERTY users press the named
// letter; when a modifier turns the key into a symbol (Option+S is "ß" on macOS),
// fall back to the physical code. Digits and backquote are positional.
const keyMatches = (key: string, event: KeyEventLike) => {
  if (key === "1-9") return /^Digit[1-9]$/.test(event.code)
  if (key === "`") return event.code === "Backquote"
  if (!/^[A-Z]$/.test(key)) return event.key === key
  if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase() === key
  return event.code === `Key${key}`
}

/* Keyboard registry (dotfiles#254, proposal v1.2). Each entry states the modifiers
 * its handler accepts, so a hint never names a key that does nothing on this
 * platform. Only `dispatched` entries may be shown as hints or in the shortcut
 * overlay; `planned` entries are approved bindings whose handlers have not landed. */

export type Platform = "mac" | "other"

// "Primary" is accepted as either Meta or Control by the handler (Cmd on macOS,
// Ctrl elsewhere). "Mod" is the app-chord modifier: Cmd on macOS, Alt elsewhere
// (D1, kitty mirror). "Meta" is literal: Cmd on macOS, Super/Windows elsewhere.
type Modifier = "Primary" | "Mod" | "Meta" | "Control" | "Alt" | "Shift"
type Status = "dispatched" | "planned"
// `where` names the surface whose handler owns the key; the overlay groups by it.
type Where = "app" | "composer" | "session" | "decision"
type Binding = { modifiers: Modifier[]; key: string; status: Status; title: string; where: Where }

const dispatched = (title: string, where: Where, key: string, ...modifiers: Modifier[]): Binding => ({ modifiers, key, status: "dispatched", title, where })
const planned = (title: string, where: Where, key: string, ...modifiers: Modifier[]): Binding => ({ modifiers, key, status: "planned", title, where })

export const SHORTCUTS = {
  // Composer primary action: label follows draft and pending state (send, steer, nudge).
  primaryAction: dispatched("Primary action (send, steer, nudge)", "composer", "Enter", "Primary"),
  // Submit outside the composer: decisions, new session, pending-input edit.
  submit: dispatched("Submit decision, new session or edit", "decision", "Enter", "Primary"),
  // session.tsx cycleMode checks metaKey only (D4 adds Ctrl+M off macOS with its handler).
  cycleTarget: dispatched("Cycle steer, queue, aside", "composer", "M", "Meta"),
  find: dispatched("Find in transcript", "session", "F", "Primary"),
  previousPrompt: dispatched("Previous prompt", "session", "P", "Control"),
  nextPrompt: dispatched("Next prompt", "session", "N", "Control"),
  expandEditor: dispatched("Float editor", "composer", "E", "Control"),
  toggleSessions: dispatched("Toggle sessions panel", "app", "H", "Control"),
  nextRegion: dispatched("Next region", "app", "F6"),
  previousRegion: dispatched("Previous region", "app", "F6", "Shift"),
  sessionFinder: planned("Session finder", "app", "S", "Mod"),
  mruBack: planned("Recent session (back)", "app", "Tab", "Control"),
  mruForward: planned("Recent session (forward)", "app", "Tab", "Control", "Shift"),
  lastSession: planned("Last session", "app", "`", "Mod"),
  pinnedSession: planned("Pinned session", "app", "1-9", "Mod"),
  needsYou: planned("Needs you", "app", "N", "Mod", "Shift"),
  commandPalette: planned("Command palette", "app", "P", "Mod"),
  focusLeft: planned("Focus region left", "app", "H", "Control", "Alt"),
  focusDown: planned("Focus region down", "app", "J", "Control", "Alt"),
  focusUp: planned("Focus region up", "app", "K", "Control", "Alt"),
  focusRight: planned("Focus region right", "app", "L", "Control", "Alt"),
} satisfies Record<string, Binding>

export type ShortcutID = keyof typeof SHORTCUTS

// Normal-scope key sequences (leader = Space, g table, ]x/[x pairs), active only
// when focus is outside text entry.
type Sequence = { keys: string[]; status: Status; title: string }
const sequence = (status: Status, title: string, ...keys: string[]): Sequence => ({ keys, status, title })

export const SEQUENCES = {
  reference: sequence("dispatched", "Keyboard shortcuts", "?"),
  referenceLeader: sequence("dispatched", "Keyboard shortcuts", "Space", "?"),
  goDesk: sequence("dispatched", "Go to Front desk", "g", "d"),
  goAgents: sequence("dispatched", "Go to Agents", "g", "a"),
  goUsage: sequence("dispatched", "Go to Usage", "g", "u"),
  goCloud: sequence("dispatched", "Go to Cloud", "g", "C"),
  goNewSession: sequence("dispatched", "New session", "g", "o"),
  pinToggle: sequence("planned", "Pin or unpin session", "Space", "m"),
  needsYouLeader: sequence("planned", "Needs you", "Space", "n"),
  parentSession: sequence("planned", "Parent session", "g", "p"),
  childSession: sequence("planned", "First child session", "g", "c"),
  nextPromptPair: sequence("planned", "Next prompt", "]", "p"),
  previousPromptPair: sequence("planned", "Previous prompt", "[", "p"),
  nextDecision: sequence("planned", "Next decision", "]", "n"),
  previousDecision: sequence("planned", "Previous decision", "[", "n"),
} satisfies Record<string, Sequence>

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
export const sequenceLabel = (id: SequenceID) => SEQUENCES[id].keys.join(" ")

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

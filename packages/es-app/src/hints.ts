/* Hint labels (dotfiles#254, DD keyboard-workflow#50; Loupe review 2026-11-04). Outside text entry, "f" labels the
 * focused region plus the main navigation, "F" labels every visible target. The nearest and most-used targets get one
 * letter; the rest two. Typing a label activates it: links and ordinary buttons are clicked; text boxes, decision,
 * question and permission controls, and destructive or turn-affecting actions are only focused, so a one-letter typo
 * never answers a decision, stops a turn or deletes anything. */
import type { Accessor, Setter } from "solid-js"

export type Hint = { label: string; el: HTMLElement; x: number; y: number }
type State = { list: Hint[]; typed: string } | undefined

// Home row first, then the rows above and below; no letters that read alike in a small label (l, i, o).
const ALPHABET = "asdfghjkqwertyuzxcvbnmp"
const TARGETS = "a[href], button:not([disabled]), textarea, input:not([type='hidden']):not([disabled]), select, summary, [role='button'], [role='tab'], [role='radio'], [role='menuitem'], [role='option'], [tabindex]:not([tabindex='-1'])"
const FOCUS_ONLY = ".decision-buttons, .decision-field, .permission-rail, [class*='permission'], [class*='question'], .generated-input, textarea, input, select"
const RISKY = /^(delete|archive|stop|fork|remove|discard|abort|cancel|reject|deny|forget|clear)\b/i
const REGIONS = "nav.sidebar, .desk-companion, .content"
// Most-used targets, labelled first after the focused region.
const FAVOURED = [".prompt-box textarea", ".direct-split button", "nav.sidebar [aria-current]", "nav .nav-entry"]

/** `count` labels, none a prefix of another: as many single letters as fit, then two letters on the remaining prefixes. */
export const hintLabels = (count: number) => {
  const size = ALPHABET.length
  if (count <= size) return [...ALPHABET].slice(0, count)
  // s singles leave size - s prefixes for size letters each.
  const singles = Math.max(0, Math.floor((size * size - count) / (size - 1)))
  const doubles = [...ALPHABET.slice(singles)].flatMap((first) => [...ALPHABET].map((second) => first + second))
  return [...ALPHABET.slice(0, singles), ...doubles].slice(0, count)
}

/** Every target a person can see and reach now: on screen, not covered, not inert or hidden. */
export const visibleTargets = () => {
  const [width, height] = [window.innerWidth, window.innerHeight]
  return [...document.querySelectorAll<HTMLElement>(TARGETS)].filter((el) => {
    if (el.closest("[inert], [aria-hidden='true'], .kbd-hints")) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.right < 0 || rect.top > height || rect.left > width) return false
    const [x, y] = [Math.min(width - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 8))), Math.min(height - 1, Math.max(0, rect.top + rect.height / 2))]
    const top = document.elementFromPoint(x, y)
    return !!top && (el === top || el.contains(top) || top.contains(el))
  })
}

/** Targets for "f" (focused region and main navigation) or "F" (all), most likely first. */
const ranked = (all: boolean) => {
  const targets = visibleTargets()
  const region = document.activeElement?.closest(REGIONS)
  const scoped = all || !region ? targets : targets.filter((el) => region.contains(el) || el.closest("nav .nav-entries"))
  const score = (el: HTMLElement) => {
    if (region?.contains(el)) return FAVOURED.some((selector) => el.matches(selector)) ? 0 : 1
    const favoured = FAVOURED.findIndex((selector) => el.matches(selector))
    return favoured < 0 ? 3 : 2
  }
  return scoped.map((el, index) => ({ el, index, score: score(el) })).sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.el)
}

// The tag sits outside the target at its inline-start edge, vertically centred; with no room there it sits over the
// target's leading icon, never over its first characters.
const place = (el: HTMLElement, label: string) => {
  const rect = el.getBoundingClientRect()
  const tag = label.length * 7 + 4
  const rtl = getComputedStyle(el).direction === "rtl"
  const outside = rtl ? rect.right + 2 : rect.left - tag - 2
  const fits = rtl ? outside + tag <= window.innerWidth : outside >= 0
  const icon = el.querySelector("svg, img")?.getBoundingClientRect()
  const x = fits ? outside : icon ? icon.left : rtl ? rect.right - tag : rect.left
  return { x: Math.max(0, x), y: Math.max(0, rect.top + rect.height / 2 - 8) }
}

export const createHints = (state: Accessor<State>, setState: Setter<State>) => {
  const cancel = () => state() && setState(undefined)
  const start = (all = false) => {
    const targets = ranked(all)
    if (!targets.length) return
    const labels = hintLabels(targets.length)
    setState({ typed: "", list: targets.slice(0, labels.length).map((el, index) => ({ label: labels[index], el, ...place(el, labels[index]) })) })
  }
  const activate = (el: HTMLElement) => {
    el.focus({ preventScroll: true })
    const name = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""
    if (el.matches(FOCUS_ONLY) || el.closest(FOCUS_ONLY) || RISKY.test(name)) return
    el.click()
  }
  const keydown = (event: KeyboardEvent) => {
    const current = state()
    if (!current || event.isComposing) return
    // Modifier presses pass through; a chord ends hinting and keeps its own meaning.
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return
    if (event.ctrlKey || event.metaKey || event.altKey) return cancel()
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.key === "Escape") return cancel()
    if (event.key === "Backspace") return setState({ ...current, typed: current.typed.slice(0, -1) })
    const typed = current.typed + event.key.toLowerCase()
    const matches = current.list.filter((hint) => hint.label.startsWith(typed))
    if (!matches.length) return cancel()
    const exact = matches.find((hint) => hint.label === typed)
    if (!exact) return setState({ ...current, typed })
    setState(undefined)
    activate(exact.el)
  }
  return { start: () => start(false), startAll: () => start(true), cancel, keydown }
}

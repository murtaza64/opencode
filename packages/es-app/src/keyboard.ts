/* App-wide keyboard dispatch for registry bindings without a surface owner
 * (dotfiles#254 v1.2). Surface handlers (composer, session page, decision card)
 * keep their own keys; this layer only runs dispatched app chords and Normal-scope
 * sequences, and steps aside for modals, text entry and IME composition. */
import { createSignal } from "solid-js"
import { currentPlatform, isTypingTarget, matchShortcut, SEQUENCES, type SequenceID, type ShortcutID } from "./shortcuts"

export type KeyboardActions = Partial<Record<ShortcutID | SequenceID, () => void>>

type Step = { kind: "match"; id: SequenceID } | { kind: "prefix"; next: { key: string; id: SequenceID }[] } | { kind: "none" }

/** Pure sequence state: feed keys one at a time. No timeout; an unbound key or Esc cancels. */
export const createSequenceMatcher = (enabled: (id: SequenceID) => boolean) => {
  const ids = (Object.keys(SEQUENCES) as SequenceID[]).filter((id) => SEQUENCES[id].status === "dispatched" && enabled(id))
  let pending: string[] = []
  return {
    pending: () => pending,
    reset: () => void (pending = []),
    feed: (key: string): Step => {
      const keys = [...pending, key]
      const exact = ids.find((id) => SEQUENCES[id].keys.join(" ") === keys.join(" "))
      if (exact) {
        pending = []
        return { kind: "match", id: exact }
      }
      const next = ids
        .filter((id) => SEQUENCES[id].keys.length > keys.length && keys.every((part, index) => SEQUENCES[id].keys[index] === part))
        .map((id) => ({ key: SEQUENCES[id].keys[keys.length], id }))
      pending = next.length ? keys : []
      return next.length ? { kind: "prefix", next } : { kind: "none" }
    },
  }
}

// Which-key popup state, shown 300 ms after a prefix so fast typists never see it.
const [whichKey, setWhichKey] = createSignal<{ prefix: string[]; next: { key: string; id: SequenceID }[] }>()
export { whichKey }

const CHORDS: ShortcutID[] = ["nextRegion", "previousRegion"]

/** Installs the capture-phase listener; returns cleanup. */
export const installKeyboard = (actions: KeyboardActions) => {
  const matcher = createSequenceMatcher((id) => Boolean(actions[id]))
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    matcher.reset()
    clearTimeout(timer)
    setWhichKey(undefined)
  }
  const handler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (modalOpen()) return cancel()
    const platform = currentPlatform()
    const chord = CHORDS.find((id) => actions[id] && matchShortcut(event, id, platform))
    if (chord) {
      consume(event)
      cancel()
      if (!event.repeat) actions[chord]!()
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return cancel()
    const key = sequenceKey(event)
    if (!key) return
    if (key === "Escape") {
      if (!matcher.pending().length) return
      consume(event)
      return cancel()
    }
    // Space and Enter activate a focused control; leave them to it.
    if (!matcher.pending().length && (key === "Space" || key === "Enter") && isActivatable(event.target)) return
    if (event.repeat) return
    const wasPending = matcher.pending().length > 0
    const step = matcher.feed(key)
    if (step.kind === "none") {
      // A pending sequence swallows the unbound key so it has no side effect.
      if (wasPending) consume(event)
      return cancel()
    }
    consume(event)
    clearTimeout(timer)
    if (step.kind === "match") {
      setWhichKey(undefined)
      return actions[step.id]!()
    }
    const prefix = matcher.pending()
    timer = setTimeout(() => setWhichKey({ prefix, next: step.next }), 300)
  }
  window.addEventListener("keydown", handler, true)
  return () => {
    window.removeEventListener("keydown", handler, true)
    cancel()
  }
}

/** F6 order: sidebar, page content, composer, Front desk chat. Skips hidden regions. */
export const cycleRegion = (step: 1 | -1) => {
  const regions = REGIONS.map((selector) => document.querySelector<HTMLElement>(selector)).filter(
    (el): el is HTMLElement => !!el && el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true",
  )
  if (!regions.length) return
  const active = document.activeElement
  // The composer lives inside .content; the innermost containing region wins.
  const current = regions.reduce((found, el, index) => (active && el.contains(active) ? index : found), -1)
  const next = regions[(current + step + regions.length) % regions.length]
  focusRegion(next)
}

const REGIONS = ["nav.sidebar", ".content", ".prompt-box textarea", ".desk-companion:not(.closed)"]

const focusRegion = (el: HTMLElement) => {
  if (el.matches("textarea, input, [tabindex]")) return el.focus()
  const first = el.querySelector<HTMLElement>("[aria-current], a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])")
  if (first) return first.focus()
  el.setAttribute("tabindex", "-1")
  el.focus()
}

const consume = (event: KeyboardEvent) => {
  event.preventDefault()
  event.stopPropagation()
}

const sequenceKey = (event: KeyboardEvent) => {
  if (event.key === " ") return "Space"
  if (event.key === "Escape" || event.key === "Enter") return event.key
  return event.key.length === 1 ? event.key : undefined
}

const modalOpen = () => !!document.querySelector("dialog[open], [role='dialog'][aria-modal='true'], [role='menu']:not([hidden])")

const isActivatable = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest("button, a[href], summary, select, [role='button'], [role='menuitem'], [role='option'], [role='tab'], input")

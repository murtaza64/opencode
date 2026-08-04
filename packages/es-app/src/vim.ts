/* Modal (vim-like) editing for a textarea: normal/insert modes with the core
 * motions and operators — h j k l, w b e, 0 ^ $, gg G, i a I A o O, x s D C S,
 * d/c/y + motion, dd cc yy, p P, u / ctrl-r. No counts, marks, registers
 * beyond one internal, or visual mode. The block cursor in normal mode is a
 * one-char selection styled via ::selection. */
import { createSignal } from "solid-js"

export type VimMode = "normal" | "insert"

type Snapshot = { value: string; sel: number }

const isWordChar = (c: string) => /[\w]/.test(c)
const isSpace = (c: string) => /\s/.test(c)

function lineStart(text: string, pos: number): number {
  const i = text.lastIndexOf("\n", Math.max(0, pos - 1))
  return i === -1 ? 0 : i + 1
}

function lineEnd(text: string, pos: number): number {
  const i = text.indexOf("\n", pos)
  return i === -1 ? text.length : i
}

function firstNonBlank(text: string, pos: number): number {
  const start = lineStart(text, pos)
  const end = lineEnd(text, pos)
  let i = start
  while (i < end && isSpace(text[i]!)) i++
  return i
}

function wordForward(text: string, pos: number): number {
  let i = pos
  const n = text.length
  if (i >= n) return n
  const startClass = isWordChar(text[i]!) ? "w" : isSpace(text[i]!) ? "s" : "p"
  if (startClass !== "s") {
    while (i < n && !isSpace(text[i]!) && (isWordChar(text[i]!) ? "w" : "p") === startClass) i++
  }
  while (i < n && isSpace(text[i]!)) i++
  return i
}

function wordBack(text: string, pos: number): number {
  let i = pos
  while (i > 0 && isSpace(text[i - 1]!)) i--
  if (i === 0) return 0
  const cls = isWordChar(text[i - 1]!) ? "w" : "p"
  while (i > 0 && !isSpace(text[i - 1]!) && (isWordChar(text[i - 1]!) ? "w" : "p") === cls) i--
  return i
}

function wordForwardBig(text: string, pos: number): number {
  let i = pos
  const n = text.length
  while (i < n && !isSpace(text[i]!)) i++
  while (i < n && isSpace(text[i]!)) i++
  return i
}

function wordBackBig(text: string, pos: number): number {
  let i = pos
  while (i > 0 && isSpace(text[i - 1]!)) i--
  while (i > 0 && !isSpace(text[i - 1]!)) i--
  return i
}

function wordEnd(text: string, pos: number): number {
  let i = pos + 1
  const n = text.length
  while (i < n && isSpace(text[i]!)) i++
  if (i >= n) return n - 1
  const cls = isWordChar(text[i]!) ? "w" : "p"
  while (i + 1 < n && !isSpace(text[i + 1]!) && (isWordChar(text[i + 1]!) ? "w" : "p") === cls) i++
  return i
}

function verticalMove(text: string, pos: number, dir: 1 | -1, goalCol: number): { pos: number; col: number } {
  const start = lineStart(text, pos)
  const col = goalCol >= 0 ? goalCol : pos - start
  if (dir === 1) {
    const end = lineEnd(text, pos)
    if (end >= text.length) return { pos, col }
    const nextStart = end + 1
    const nextEnd = lineEnd(text, nextStart)
    return { pos: Math.min(nextStart + col, nextEnd), col }
  }
  if (start === 0) return { pos, col }
  const prevStart = lineStart(text, start - 1)
  const prevEnd = start - 1
  return { pos: Math.min(prevStart + col, prevEnd), col }
}

export function createVim(opts: {
  value: () => string
  setValue: (v: string) => void
  /** navigation hooks (normal mode) */
  onTab?: (back: boolean) => void
  onEnter?: () => void
  /** fired whenever the normal-mode cursor moves; hasChar=false means the
   * selection block can't render (EOL/empty) and a fake caret is needed */
  onCursor?: (info: { el: HTMLTextAreaElement; pos: number; hasChar: boolean }) => void
}) {
  const [mode, setMode] = createSignal<VimMode>("normal")
  let pendingOp: "d" | "c" | "y" | null = null
  let gPending = false
  let register = ""
  let registerLinewise = false
  let goalCol = -1
  const undoStack: Snapshot[] = []
  const redoStack: Snapshot[] = []

  const el = (e: KeyboardEvent) => e.currentTarget as HTMLTextAreaElement

  const cursor = (t: HTMLTextAreaElement) => t.selectionStart ?? 0

  const paint = (t: HTMLTextAreaElement, pos: number) => {
    const text = t.value
    const p = Math.max(0, Math.min(pos, text.length))
    const hasChar = p < text.length && text[p] !== "\n"
    if (mode() === "normal" && hasChar) {
      t.setSelectionRange(p, p + 1)
    } else {
      t.setSelectionRange(p, p)
    }
    opts.onCursor?.({ el: t, pos: p, hasChar })
  }

  const snapshot = (t: HTMLTextAreaElement) => {
    undoStack.push({ value: t.value, sel: cursor(t) })
    if (undoStack.length > 200) undoStack.shift()
    redoStack.length = 0
  }

  const apply = (t: HTMLTextAreaElement, value: string, pos: number) => {
    opts.setValue(value)
    t.value = value
    paint(t, pos)
  }

  const enterInsert = (t: HTMLTextAreaElement, pos: number) => {
    setMode("insert")
    pendingOp = null
    t.setSelectionRange(pos, pos)
  }

  const enterNormal = (t: HTMLTextAreaElement) => {
    setMode("normal")
    pendingOp = null
    gPending = false
    paint(t, Math.max(0, cursor(t) - (mode() === "insert" ? 1 : 0)))
  }

  const motionTarget = (t: HTMLTextAreaElement, key: string, forOperator: boolean): [number, number, boolean] | null => {
    // returns [from, to, linewise]
    const text = t.value
    const pos = cursor(t)
    switch (key) {
      case "h":
        return [Math.max(lineStart(text, pos), pos - 1), pos, false]
      case "l":
        return [pos, Math.min(lineEnd(text, pos), pos + 1), false]
      case "w": {
        const to = wordForward(text, pos)
        // dw/cw stop at line end when the word continues past it (approximation)
        return [pos, forOperator ? Math.min(to, lineEnd(text, pos) + 1) : to, false]
      }
      case "W": {
        const to = wordForwardBig(text, pos)
        return [pos, forOperator ? Math.min(to, lineEnd(text, pos) + 1) : to, false]
      }
      case "b":
        return [wordBack(text, pos), pos, false]
      case "B":
        return [wordBackBig(text, pos), pos, false]
      case "e": {
        const to = wordEnd(text, pos)
        return [pos, forOperator ? to + 1 : to, false]
      }
      case "0":
        return [lineStart(text, pos), pos, false]
      case "^":
        return [firstNonBlank(text, pos), pos, false]
      case "$":
        return [pos, lineEnd(text, pos), false]
      case "j": {
        const from = lineStart(text, pos)
        const to = lineEnd(text, verticalMove(text, pos, 1, -1).pos)
        return [from, Math.min(to + 1, text.length), true]
      }
      case "k": {
        const up = verticalMove(text, pos, -1, -1).pos
        const from = lineStart(text, up)
        return [from, Math.min(lineEnd(text, pos) + 1, text.length), true]
      }
      case "G":
        return [lineStart(text, pos), text.length, true]
      default:
        return null
    }
  }

  const runOperator = (t: HTMLTextAreaElement, op: "d" | "c" | "y", from: number, to: number, linewise: boolean) => {
    const text = t.value
    const chunk = text.slice(from, to)
    register = chunk
    registerLinewise = linewise
    if (op === "y") {
      paint(t, from)
      return
    }
    snapshot(t)
    const next = text.slice(0, from) + text.slice(to)
    apply(t, next, from)
    if (op === "c") enterInsert(t, from)
  }

  const lineRange = (text: string, pos: number): [number, number] => [
    lineStart(text, pos),
    Math.min(lineEnd(text, pos) + 1, text.length),
  ]

  const handleNormal = (e: KeyboardEvent): boolean => {
    const t = el(e)
    const text = t.value
    const pos = cursor(t)
    const key = e.key
    if (e.metaKey) return false
    if (e.ctrlKey) {
      if (key === "r") {
        const snap = redoStack.pop()
        if (snap) {
          undoStack.push({ value: t.value, sel: pos })
          apply(t, snap.value, snap.sel)
        }
        return true
      }
      return false
    }

    // pending operator: expect a motion (or doubled operator for linewise)
    if (pendingOp) {
      const op = pendingOp
      pendingOp = null
      if (key === op) {
        const [from, to] = lineRange(text, pos)
        runOperator(t, op, from, to, true)
        return true
      }
      if (key === "g") {
        gPending = true
        pendingOp = op
        return true
      }
      if (gPending) {
        gPending = false
        if (key === "g") {
          runOperator(t, op, 0, Math.min(lineEnd(text, pos) + 1, text.length), true)
          return true
        }
        return true
      }
      const m = motionTarget(t, key, true)
      if (m) runOperator(t, op, m[0], m[1], m[2])
      return true
    }

    if (gPending) {
      gPending = false
      if (key === "g") {
        goalCol = -1
        paint(t, 0)
        return true
      }
      return true
    }

    switch (key) {
      case "Escape":
        return true
      case "i":
        enterInsert(t, pos)
        return true
      case "a":
        enterInsert(t, Math.min(pos + 1, lineEnd(text, pos)))
        return true
      case "I":
        enterInsert(t, firstNonBlank(text, pos))
        return true
      case "A":
        enterInsert(t, lineEnd(text, pos))
        return true
      case "o": {
        snapshot(t)
        const end = lineEnd(text, pos)
        apply(t, text.slice(0, end) + "\n" + text.slice(end), end + 1)
        enterInsert(t, end + 1)
        return true
      }
      case "O": {
        snapshot(t)
        const start = lineStart(text, pos)
        apply(t, text.slice(0, start) + "\n" + text.slice(start), start)
        enterInsert(t, start)
        return true
      }
      case "h":
      case "l":
      case "w":
      case "W":
      case "b":
      case "B":
      case "e":
      case "0":
      case "^":
      case "$": {
        goalCol = -1
        const m = motionTarget(t, key, false)
        if (!m) return true
        let target = ["h", "b", "B", "0", "^"].includes(key) ? m[0] : m[1]
        // $ sits ON the last character, not past it
        if (key === "$" && target > lineStart(text, pos)) target -= 1
        paint(t, target)
        return true
      }
      case "j":
      case "k": {
        const r = verticalMove(text, pos, key === "j" ? 1 : -1, goalCol)
        goalCol = r.col
        paint(t, r.pos)
        return true
      }
      case "g":
        gPending = true
        return true
      case "G": {
        goalCol = -1
        paint(t, lineStart(text, text.length))
        return true
      }
      case "x": {
        if (pos < text.length && text[pos] !== "\n") {
          snapshot(t)
          register = text[pos]!
          registerLinewise = false
          apply(t, text.slice(0, pos) + text.slice(pos + 1), pos)
        }
        return true
      }
      case "s": {
        snapshot(t)
        apply(t, text.slice(0, pos) + text.slice(pos + 1), pos)
        enterInsert(t, pos)
        return true
      }
      case "D":
      case "C": {
        snapshot(t)
        const end = lineEnd(text, pos)
        register = text.slice(pos, end)
        registerLinewise = false
        apply(t, text.slice(0, pos) + text.slice(end), pos)
        if (key === "C") enterInsert(t, pos)
        return true
      }
      case "S": {
        snapshot(t)
        const [from, to] = lineRange(text, pos)
        const keepNl = text[to - 1] === "\n" ? "\n" : ""
        apply(t, text.slice(0, from) + keepNl + text.slice(to), from)
        enterInsert(t, from)
        return true
      }
      case "d":
      case "c":
      case "y":
        pendingOp = key as "d" | "c" | "y"
        return true
      case "p":
      case "P": {
        if (!register) return true
        snapshot(t)
        if (registerLinewise) {
          const at = key === "p" ? Math.min(lineEnd(text, pos) + 1, text.length) : lineStart(text, pos)
          const chunk = register.endsWith("\n") ? register : register + "\n"
          apply(t, text.slice(0, at) + chunk + text.slice(at), at)
        } else {
          const at = key === "p" ? Math.min(pos + 1, text.length) : pos
          apply(t, text.slice(0, at) + register + text.slice(at), at + register.length - 1)
        }
        return true
      }
      case "u": {
        const snap = undoStack.pop()
        if (snap) {
          redoStack.push({ value: t.value, sel: pos })
          apply(t, snap.value, snap.sel)
        }
        return true
      }
      case "Tab": {
        opts.onTab?.(e.shiftKey)
        return true
      }
      case "Enter": {
        opts.onEnter?.()
        return true
      }
      default:
        // swallow printable keys in normal mode so they don't type
        return key.length === 1
    }
  }

  /** returns true when the event was consumed */
  const handleKeyDown = (e: KeyboardEvent): boolean => {
    const t = el(e)
    if (mode() === "insert") {
      if (e.key === "Escape") {
        snapshot(t)
        undoStack.pop() // snapshot() cleared redo; keep a light heuristic:
        undoStack.push({ value: t.value, sel: Math.max(0, cursor(t) - 1) })
        setMode("normal")
        paint(t, Math.max(0, cursor(t) - 1))
        return true
      }
      // emacs-style word motion; match on code — macOS alt+f/b types ƒ/∫
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "KeyF" || e.code === "KeyB")) {
        const pos = cursor(t)
        const next = e.code === "KeyF" ? wordForward(t.value, pos) : wordBack(t.value, pos)
        t.setSelectionRange(next, next)
        e.preventDefault()
        return true
      }
      return false
    }
    const consumed = handleNormal(e)
    if (consumed) e.preventDefault()
    return consumed
  }

  /** re-assert the block cursor (e.g. after focus or external value change) */
  const refresh = (t: HTMLTextAreaElement | undefined) => {
    if (t && mode() === "normal") paint(t, cursor(t))
  }

  return { mode, setMode, handleKeyDown, refresh, enterInsertAt: enterInsert }
}
